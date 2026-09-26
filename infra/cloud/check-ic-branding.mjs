import {readFileSync,writeFileSync} from 'node:fs';
const base='https://main.d21bivg674x6ke.amplifyapp.com';
const sessions=JSON.parse(readFileSync('.build/cloud/loyalty-check-sessions.json'));
async function get(path,role){
 const r=await fetch(base+path,{headers:role?{authorization:`Bearer ${sessions[role].token}`}:{},signal:AbortSignal.timeout(30000)});
 const d=await r.json();if(!r.ok)throw Error(`Read ${path} failed ${r.status}`);return d;
}
const config=await get('/v1/config');
if(config.token.symbol!=='icUSD'||config.token.name!=='IC Stablecoin'||config.token.onchainSymbol!=='MJPY'||config.token.address!=='0x9191e7d4aed20411b2b068f43e40bd325e5ede0e')throw Error('Branding configuration not active');
const dashboard=await get('/v1/dashboard','customer');
const before=JSON.parse(readFileSync('.build/cloud/ic-branding-before.json'));
for(const old of before.cards??[]){
 const card=dashboard.cards?.find(c=>c.id===old.id);if(!card)throw Error('Card changed');
 if(old.wallet){
  if(card.wallet?.address!==old.wallet.address||card.wallet?.balance!==old.wallet.balance||card.wallet?.decimals!==old.wallet.decimals)throw Error('Wallet state changed; inspect independently');
  if(card.wallet.symbol!=='icUSD'||card.wallet.onchainSymbol!=='MJPY')throw Error('Wallet branding missing');
 }
 for(const key of ['enabled','perPaymentLimit','totalLimit','spent','reserved','routerAddress','useRewards','maxPointsPerPayment'])if(card.policy?.[key]!==old.policy?.[key])throw Error('Policy changed: '+key);
}
const vouchers=await get('/v1/collectibles','customer');
if(vouchers.status!=='available'||vouchers.items?.some(v=>v.symbol!=='icUSD'))throw Error('Voucher data unavailable or branding missing');
const funding=await get('/v1/funding','customer');
if(funding.status!=='available'||funding.transfers?.some(t=>t.symbol!=='icUSD'))throw Error('Funding data unavailable or branding missing');
writeFileSync('.build/cloud/ic-branding-verified.json',JSON.stringify({checkedAt:new Date().toISOString(),token:config.token,walletCount:dashboard.cards?.length,voucherCount:vouchers.items?.length,fundingCount:funding.transfers?.length,amountsAndPermissionUnchanged:true}),{mode:0o600});
console.log(JSON.stringify({branding:'IC Stablecoin (icUSD)',onchainSymbol:config.token.onchainSymbol,walletsVerified:dashboard.cards?.length,vouchersVerified:vouchers.items?.length,amountsAndPermissionsUnchanged:true}));
