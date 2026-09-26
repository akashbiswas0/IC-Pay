export type Payment = {
  pointsRedeemed?: string;
  pointsEarnedUnits?: string;
  grossAmount?: string;
  discountAmount?: string;
  rewardId?: string | null;
  cardId?: string | null;
  errorCode?: string | null;
  id: string;
  merchantName: string;
  amount: string;
  symbol: string;
  decimals: number;
  status: string;
  createdAt: string;
  txHash: string | null;
  explorerUrl: string | null;
};
export type Policy = {
  maxPointsPerPayment?: string | null;
  merchantScope?: "selected" | "all";
  requiresApproval?: boolean;
  useRewards?: boolean;
  routerAddress?: string;
  enabled: boolean;
  perPaymentLimit: string;
  totalLimit: string;
  spent: string;
  reserved: string;
  expiresAt: string;
  merchantIds?: string[];
};
export type Wallet = {
  address: string;
  balance: string | null;
  balanceStatus: "available" | "pending_setup" | "unavailable";
  symbol: string;
  decimals: number;
  chainId: string;
};
export type LinkedCard = {
  id: string;
  nickname: string;
  last4: string;
  status: string;
  wallet: Wallet | null;
  walletStatus: "none" | "provisioning" | "ready" | "needs_attention";
  policy: Policy | null;
  allowanceSufficient: boolean | null;
};
export type Dashboard = {
  account: { id: string; verified: boolean; role: string };
  wallet: Wallet | null;
  cards?: LinkedCard[];
  unassignedWalletAvailable?: boolean;
  card: { linked: boolean; last4: string | null };
  policy: Policy | null;
  payments: Payment[];
  merchant: {
    id: string;
    name: string;
    recipient: string;
    confirmedCount: number;
    receivedTotal: string;
  } | null;
};
export type Config = {
  paymentRouter?: { address: string; kind: string };
  chainId: string;
  token: {
    address: string;
    symbol: string;
    decimals: number;
    name?: string;
    onchainSymbol?: string;
  };
  explorerUrl: string | null;
  world: { appId: string; environment: string };
  capabilities: {
    payments: boolean;
    world: boolean;
    rewards?: boolean;
    collectibles?: boolean;
    loyalty?: boolean;
  };
};
export type Connection = { base: string; token: string };
export type Reward = {
  rewardType?: "credit" | "percentage";
  tokenId?: string;
  contractAddress?: string;
  collectionKey?: string;
  imageUrl?: string | null;
  creditAmount?: string | null;
  remainingCredit?: string | null;
  purchaseAmount?: string | null;
  nftOwned?: boolean;
  events?: {
    id: string;
    kind: "earned" | "redeemed";
    createdAt: string;
    txHash: string;
    explorerUrl: string | null;
    discountAmount?: string;
    remainingCredit?: string;
  }[];
  id: string;
  cardId: string | null;
  walletAddress: string;
  merchantId: string;
  merchantName: string;
  discountBps: number | null;
  maxDiscount: string | null;
  minPurchase: string | null;
  expiresAt: string;
  status: "available" | "reserved" | "used" | "expired";
  earnedAt: string | null;
  redeemedAt: string | null;
  earnedTxHash: string | null;
  redeemedTxHash: string | null;
  earnedExplorerUrl: string | null;
  redeemedExplorerUrl: string | null;
};
export type RewardResponse = {
  status: "available" | "pending_setup" | "unavailable";
  rewards: Reward[] | null;
  routerAddress: string | null;
};
export type CollectiblesResponse = {
  status: RewardResponse["status"];
  items: Reward[] | null;
  routerAddress: string | null;
};
export type CreditCampaign = {
  enabled: boolean;
  minPurchase: string;
  earnBps: number;
  maxCredit: string;
  validitySeconds: number;
  version: number | string;
};
export type CreditCampaignResponse = {
  status: RewardResponse["status"];
  campaign: CreditCampaign | null;
  operation: RewardCampaignResponse["operation"];
};
export type RewardCampaign = {
  enabled: boolean;
  minPurchase: string;
  discountBps: number;
  maxDiscount: string;
  validitySeconds: number;
  version: number | string;
};
export type RewardCampaignResponse = {
  status: "available" | "pending_setup" | "unavailable";
  campaign: RewardCampaign | null;
  operation: {
    id: string;
    status: string;
    txHash: string | null;
    errorCode: string | null;
  } | null;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  connection: Connection,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const base = connection.base.trim().replace(/\/$/, "");
  if (base) {
    const url = new URL(base);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      throw new Error(
        "The secure connection is unavailable. Please try again later.",
      );
    if (url.username || url.password || url.search || url.hash)
      throw new Error(
        "The account connection is unavailable. Please try again later.",
      );
  }
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(connection.token
        ? { Authorization: `Bearer ${connection.token}` }
        : {}),
      ...options.headers,
    },
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    cache: "no-store",
    credentials: "include",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status,
      body?.error?.message ||
        `The server returned ${response.status}. Try again or check the connection.`,
    );
  if (!body) throw new Error("The server returned an invalid response.");
  return body as T;
}
