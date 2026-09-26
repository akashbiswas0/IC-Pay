import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Run after the new API image and loyalty router configuration are live.
// Uses the existing durable operator transaction journal and per-wallet lock.
process.umask(0o077);
const state = JSON.parse(readFileSync(".build/cloud/state.json"));
const outputs = JSON.parse(readFileSync(".build/cloud/outputs.json"));
const aws = (args) =>
  JSON.parse(
    execFileSync(
      "aws",
      [...args, "--region", state.region, "--output", "json"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ) || "{}",
  );
const service = aws([
  "ecs",
  "describe-services",
  "--cluster",
  outputs.ClusterName,
  "--services",
  outputs.ApiServiceName,
]).services[0];
const base = aws([
  "ecs",
  "describe-task-definition",
  "--task-definition",
  service.taskDefinition,
]).taskDefinition;
const allowed = [
  "family",
  "taskRoleArn",
  "executionRoleArn",
  "networkMode",
  "containerDefinitions",
  "volumes",
  "placementConstraints",
  "requiresCompatibilities",
  "cpu",
  "memory",
  "runtimePlatform",
];
const definition = Object.fromEntries(
  Object.entries(base).filter(([key]) => allowed.includes(key)),
);
definition.family = "suica-pay-loyalty-registration";
const container = definition.containerDefinitions[0];
container.name = "check";
delete container.healthCheck;
delete container.portMappings;
container.entryPoint = ["node"];
container.command = [
  "--input-type=module",
  "-e",
  `
await(await import('./dist/runtime-secrets.js')).initializeRuntimeEnvironment();
const {pool}=await import('./dist/db.js');
const {config,hasLoyalty}=await import('./dist/config.js');
const {multibaas,merchantBytes32}=await import('./dist/multibaas.js');
const {submitOperator,reconcileOperator}=await import('./dist/operator.js');
const {id}=await import('ethers');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const tuple=(output,keys)=>Array.isArray(output)?output:keys.map(key=>output[key]);
async function operation(method,args,key){
 const hash=id(config.LOYALTY_PAYMENT_ADDRESS+'/'+key).slice(2,34);
 const uuid=[hash.slice(0,8),hash.slice(8,12),hash.slice(12,16),hash.slice(16,20),hash.slice(20)].join('-');
 let op;
 if((await pool.query('SELECT id FROM operator_transactions WHERE id=$1',[uuid])).rows[0]) op=await reconcileOperator(uuid);
 else for(let attempt=0;;attempt++){
  try { op=await submitOperator(config.AWS_KMS_OPERATOR_KEY_ID,config.LOYALTY_PAYMENT_ADDRESS,config.LOYALTY_PAYMENT_CONTRACT,method,args,uuid);break; }
  catch(error){if(error.code!=='wallet_operation_pending'||attempt>=30)throw error;await delay(4000);}
 }
 for(let attempt=0;op.status!=='confirmed'&&attempt<90;attempt++){
  if(op.status==='failed')throw Error('operation_reverted');await delay(4000);op=await reconcileOperator(uuid);
 }
 if(op.status!=='confirmed')throw Error('operation_pending');
 return op;
}
try {
 if(!hasLoyalty||config.CHAIN_ID!=='11155111')throw Error('loyalty_unconfigured');
 const shops=(await pool.query('SELECT id,recipient FROM merchants WHERE enabled ORDER BY id')).rows;
 for(const shop of shops){
  const key=merchantBytes32(shop.id);
  const read=async(method)=> (await multibaas.call(config.LOYALTY_PAYMENT_ADDRESS,config.LOYALTY_PAYMENT_CONTRACT,method,[key])).output;
  let [recipient,enabled]=tuple(await read('merchants'),['recipient','enabled']);
  if(String(recipient).toLowerCase()!=='0x'+'00'.repeat(20)&&String(recipient).toLowerCase()!==shop.recipient)throw Error('recipient_mismatch');
  if(String(recipient).toLowerCase()!==shop.recipient||enabled!==true)await operation('setMerchant',[key,shop.recipient,true],shop.id+'/registration');
  [recipient,enabled]=tuple(await read('merchants'),['recipient','enabled']);
  if(String(recipient).toLowerCase()!==shop.recipient||enabled!==true)throw Error('registration_unconfirmed');
  const current=tuple(await read('campaigns'),['enabled','minPurchase','earnBps','maxEarnPoints','validitySeconds','version']);
  let migrated=false;
  if(BigInt(current[5])===0n&&config.COLLECTIBLE_PAYMENT_ADDRESS){
   const previous=tuple((await multibaas.call(config.COLLECTIBLE_PAYMENT_ADDRESS,config.COLLECTIBLE_PAYMENT_CONTRACT,'campaigns',[key])).output,['enabled','minPurchase','earnBps','maxCredit','validitySeconds','version']);
   if(previous[0]===true){
    const unit=10n**BigInt(config.TOKEN_DECIMALS),cap=BigInt(previous[3]);
    // Never silently round or expand an existing merchant's reward cap.
    if(cap%unit!==0n||cap/unit===0n)throw Error('campaign_cap_requires_review');
    await operation('setCampaign',[key,true,String(previous[1]),Number(previous[2]),String(cap/unit),Number(previous[4])],shop.id+'/campaign-v'+String(previous[5]));
    const confirmed=tuple(await read('campaigns'),['enabled','minPurchase','earnBps','maxEarnPoints','validitySeconds','version']);
    if(confirmed[0]!==true||String(confirmed[1])!==String(previous[1])||Number(confirmed[2])!==Number(previous[2])||BigInt(confirmed[3])!==cap/unit||Number(confirmed[4])!==Number(previous[4]))throw Error('campaign_mismatch');
    migrated=true;
   }
  }
  console.log(JSON.stringify({merchantId:shop.id,registered:true,programMigrated:migrated,existingProgram:Number(current[5])>0}));
 }
}catch(error){console.error(JSON.stringify({loyaltyRegistrationFailed:true,code:typeof error.code==='string'?error.code:typeof error.message==='string'&&/^[a-z_]+$/.test(error.message)?error.message:'operation_failed'}));process.exitCode=1;}
finally{await pool.end();}
`,
];
const path = ".build/cloud/loyalty-register-definition.json";
writeFileSync(path, JSON.stringify(definition), { mode: 0o600 });
const registered = aws([
  "ecs",
  "register-task-definition",
  "--cli-input-json",
  `file://${process.cwd()}/${path}`,
]).taskDefinition.taskDefinitionArn;
const result = aws([
  "ecs",
  "run-task",
  "--cluster",
  outputs.ClusterName,
  "--task-definition",
  registered,
  "--launch-type",
  "FARGATE",
  "--network-configuration",
  JSON.stringify(service.networkConfiguration),
]);
if (result.failures?.length || !result.tasks[0])
  throw Error("Could not start loyalty registration");
writeFileSync(
  ".build/cloud/task-loyalty-registration.json",
  JSON.stringify({
    arn: result.tasks[0].taskArn,
    definition: registered,
    mode: "loyalty-registration",
  }),
  { mode: 0o600 },
);
console.log(JSON.stringify({ registrationTask: result.tasks[0].taskArn }));
