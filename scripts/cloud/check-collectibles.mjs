import{readFileSync,writeFileSync}from'node:fs';process.umask(0o077);
const {token}=JSON.parse(readFileSync('.build/cloud/funding-check-session.json'));
const origin='https://main.d21bivg674x6ke.amplifyapp.com';
const get=async(path)=>{const r=await fetch(origin+path,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});const data=await r.json();if(!r.ok)throw Error(`${path}: ${r.status} ${data.error?.code||'unknown'}`);return data};
const cfg=await get('/v1/config');if(!cfg.capabilities.collectibles||cfg.paymentRouter.address!=='0xa857a22c19a217404ac07fa43e53046ca3f5c592')throw Error('Collectibles router not active');
const dashboard=await get('/v1/dashboard');const all=await get('/v1/collectibles');if(all.status!=='available')throw Error('Collection unavailable');
const old=await get('/v1/rewards');if(old.status!=='available')throw Error('Legacy reward history unavailable');
for(const item of all.items){if(item.rewardType==='credit'&&(!item.nftOwned||!item.imageUrl?.startsWith('https://main.d21bivg674x6ke.amplifyapp.com/nft-art/07da091cde725ea51a19/')))throw Error('Collectible metadata not verified');}
writeFileSync('.build/cloud/collectibles-customer-status.json',JSON.stringify({config:cfg,items:all.items,cards:dashboard.cards},null,2),{mode:0o600});
console.log(JSON.stringify({collectiblesEnabled:true,legacyHistoryAvailable:true,items:all.items.map(i=>({id:i.collectionKey,status:i.status,credit:i.remainingCredit,nftOwned:i.nftOwned})),cards:dashboard.cards.map(c=>({cardId:c.id,merchantScope:c.policy?.merchantScope,requiresApproval:c.policy?.requiresApproval,useRewards:c.policy?.useRewards}))}));
