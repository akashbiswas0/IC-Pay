# IC Pay

## 1️⃣ A one-sentence summary of our project

IC Pay links a physical Suica to a World-verified crypto wallet so customers can pay participating merchants by tapping their card against an iPhone, with blockchain payments and activity powered by Curvegrid MultiBaas.

## 2️⃣ How we used MultiBaas and which network we deployed on

**Deployed network: Ethereum Sepolia - chain ID `11155111`.**

MultiBaas connects our TypeScript backend to the token and payment contracts. The native SwiftUI app reads the card through Core NFC, the backend authorizes the payment against the customer's spending permission, AWS KMS signs it, and MultiBaas submits it and supplies the chain data used to confirm settlement.

| MultiBaas integration                  | How IC Pay uses it                                                                                                                                                  | Implementation                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Contract API                           | Reads token balances, spending allowances, merchant recipients, and payment/reward contract state.                                                                  | [MultiBaas adapter](apps/api/src/multibaas.ts)                                            |
| Transaction preparation and submission | Prepares unsigned contract transactions, then broadcasts the raw transaction signed by AWS KMS.                                                                     | [Payment worker](apps/api/src/worker.ts), [KMS signer](apps/api/src/aws-kms.ts)           |
| Event Queries                          | Queries indexed ERC-20 `Transfer` events for incoming funding activity.                                                                                             | [Incoming transfer queries](apps/api/src/multibaas.ts)                                    |
| Payment confirmation                   | Reads transaction receipts, events, blocks, and confirmation depth before marking an invoice paid; reconciles ambiguous submissions without blindly rebroadcasting. | [Payment worker](apps/api/src/worker.ts), [settlement checks](apps/api/src/settlement.ts) |
| Webhooks                               | Accepts signed MultiBaas notifications at `/v1/webhooks/multibaas` to wake reconciliation; the worker independently verifies receipts.                              | [Webhook handler](apps/api/src/webhooks.ts)                                               |
| Contract deployment                    | Prepares and broadcasts AWS KMS-signed contract deployments through MultiBaas.                                                                                      | [Deployment script](contracts/scripts/deploy-multibaas.ts)                                |

MultiBaas handles blockchain interaction; AWS KMS holds the signing keys. Dashboard balance reads can fall back to a configured read-only RPC during MultiBaas rate limiting, and reward reads can use a separate RPC checked against MultiBaas block hashes.

### Sepolia deployment evidence

| Contract                           | Deployed address                             | Deployment transaction                                                                                                          |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| MatsuriStablecoin                  | `0x9191e7d4aed20411b2b068f43e40bd325e5ede0e` | [View on Sepolia Etherscan](https://sepolia.etherscan.io/tx/0x64951b62e8acd0966126ee185f5857f6f480a29202ac3ca4c1ce1ae689e83789) |
| DemoPayments (base payment router) | `0xa02f82ac49b421c059faed1c49c89ca6460f7ea7` | [View on Sepolia Etherscan](https://sepolia.etherscan.io/tx/0xd3a96183ece9a56162c96b382aacaec7157f85586f3c3756cec88e16eeafe8e7) |

The token contract comes from Curvegrid's Matsuri stablecoin workshop sample; the [original license](contracts/licenses/Curvegrid-MIT.txt) is retained. Its deployed metadata is **MJPY**, with 18 decimals. The app displays this test asset as **IC Stablecoin (icUSD)**; that label does not change its onchain denomination or imply USD backing.

World verifies account enrollment, card linking/replacement, and returning-user session continuity. The [native IDKit integration](apps/ios/SuicaPay/NativeWorldSession.swift) requests a Selfie credential, and the [backend](apps/api/src/world.ts) verifies the complete proof with World before applying the account/card change.

## 3️⃣ A brief intro to our team and social handles

We are the team behind IC Pay, building a tap to pay experience that connects familiar physical IC cards with crypto payments.

- **Devesh** — [@deveshtwt_ on X](https://x.com/deveshtwt_).
- **Akash** - [@akashbtwts on X](https://x.com/akashbtwts_)

## 4️⃣ Clear setup and testing instructions

### Prerequisites

- Node.js **22.16+** and npm.
- A running PostgreSQL instance and permission to create development/test databases.
- For live payments: a Sepolia MultiBaas deployment/API key, AWS KMS access, Sepolia ETH, and test tokens.
- For verification: World app/RP configuration and its server signing key.
- For the native app: an Apple Silicon Mac, Xcode 27, Rust via `rustup`, and a provisioned NFC-capable iPhone for physical card tests.

### Install and configure

Run from the repository root:

```sh
npm install
# Only when .env does not already exist:
cp .env.example .env
# Generate a value for CARD_HMAC_SECRET, then paste it into .env:
openssl rand -hex 32
```

Edit `.env` with the following values. Keep the card lookup secret stable after linking cards, and keep all server credentials out of the iPhone app and browser bundle.

| Configuration   | Required values                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database        | `DATABASE_URL=postgresql://localhost:5432/suica_payments`; `CARD_HMAC_SECRET` from the command above.                                                                  |
| MultiBaas       | `MULTIBAAS_URL`, `MULTIBAAS_API_KEY`, and `MULTIBAAS_WEBHOOK_SECRET` for your deployment.                                                                              |
| Sepolia         | `CHAIN_ID=11155111`, `EXPLORER_URL=https://sepolia.etherscan.io`, `TOKEN_DECIMALS=18`, and actual `TOKEN_ADDRESS` / `PAYMENT_ADDRESS` on that chain.                   |
| Contract labels | `TOKEN_CONTRACT=matsuristablecoin`, `PAYMENT_CONTRACT=demopayments`; match the labels registered in your MultiBaas deployment.                                         |
| Signing         | `AWS_REGION`, `AWS_KMS_OPERATOR_KEY_ID`, and AWS credentials through the standard SDK credential chain. The operator key must be `ECC_SECG_P256K1` with `SIGN_VERIFY`. |
| World           | `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNING_KEY`, and the matching `WORLD_ENVIRONMENT`; staging also needs `WORLD_STAGING_VERIFICATION_TOKEN`.                       |
| Local web       | `CORS_ORIGIN=http://localhost:5173`; the API defaults to port `3001`.                                                                                                  |

AWS wallet provisioning also needs key creation, tagging, alias, lookup, and signing permissions. The [cloud template](infra/cloud/stack.yaml) contains the application's IAM policy. Optional reward routers and RPC/history sources are configured separately in [backend configuration](apps/api/src/config.ts).

### Connect contracts to MultiBaas

1. Build the contracts and exported ABIs:

   ```sh
   npm run build -w @suica/contracts
   ```

2. Register the compiled ABI and bytecode for `MatsuriStablecoin` and `DemoPayments` in MultiBaas at version `1.0.0`, using the labels above. Build outputs are in `contracts/artifacts/src/` and `contracts/abi/`.
3. For read-only inspection, link the recorded Sepolia addresses to their ABIs. For an independent payment demo, deploy your own contracts so your operator controls minting and merchant registration. Set `TESTNET_CHAIN_ID=11155111` and `CONTRACT_ADMIN_ADDRESS` to your operator address, and fund that address with Sepolia ETH:

   ```sh
   npm run deploy:multibaas -w @suica/contracts -- --preflight
   # Creates contracts on Sepolia and spends testnet gas:
   npm run deploy:multibaas -w @suica/contracts -- --execute
   ```

4. Set the returned addresses in `.env`, link them to the registered contracts in MultiBaas, and enable indexing for `Transfer`, `PaymentCompleted`, and merchant events from the available deployment/history blocks.
5. Configure signed MultiBaas webhook delivery to your publicly reachable HTTPS `/v1/webhooks/multibaas` endpoint with the matching server secret. Payment confirmation still depends on independently verified chain receipts.

### Start the application

```sh
createdb suica_payments
npm run db:migrate
npm run check:config
npm run dev
```

The dashboard runs at [localhost:5173](http://localhost:5173) and the API health endpoint at [127.0.0.1:3001/health](http://127.0.0.1:3001/health). The development command starts the API, payment worker, and web server together. `check:config` checks configuration presence, not credential validity. Restart the services after changing `.env`.

For the iPhone app, build the pinned native World SDK with `npm run build:world:native`, copy `apps/ios/Config/Environment.example.xcconfig` to `Environment.xcconfig` in the same directory, and fill in trusted HTTPS API/dashboard origins reachable from the phone. Open `apps/ios/SuicaPay.xcodeproj`, select the `SuicaPay` scheme, and configure Apple signing and the NFC Tag Reading capability. The backend must accept the hosted web origin through `CORS_ORIGIN`.

### Automated tests

```sh
npm run build
npm run typecheck
npm test
```

Contract tests deploy and exercise contracts on Hardhat's local EVM. API database tests require a separate database whose name ends in `_test`; they clear its application records:

```sh
createdb suica_payments_test
DATABASE_URL=postgresql://localhost:5432/suica_payments_test npm run db:migrate
TEST_DATABASE_URL=postgresql://localhost:5432/suica_payments_test npm test -w @suica/api
```

Without `TEST_DATABASE_URL`, database integration tests are skipped. Local tests do not establish that live World verification, NFC, or Sepolia settlement works.

### Physical payment acceptance test

1. On the customer iPhone, link a physical Suica, complete World verification, and wait for the card wallet to be provisioned.
2. Fund that wallet with Sepolia ETH and test MJPY. The token issuer can mint using `npm run admin -w apps/api -- mint WALLET_ADDRESS AMOUNT_BASE_UNITS`; amounts use 18 decimals.
3. On the merchant iPhone, create a merchant account and wait for the worker to confirm its onchain registration, then activate the terminal.
4. On the customer app, approve the bounded token allowance and explicitly enable spending permission for the intended merchants and limits.
5. Create an invoice on the merchant phone and tap the linked card. Confirm the invoice moves to Paid only after settlement, then compare the receipt, balance change, and transaction on Sepolia Etherscan.
6. Refresh dashboard activity to inspect funding/payment records backed by MultiBaas chain data.

IC Pay spends the linked crypto wallet's test tokens, not the Suica's yen balance, and works with participating demo merchant iPhones rather than standard transit/payment terminals.

## 6️⃣ A short video demo or slide deck

**Pending: add the public demo video or slide-deck URL before submitting for the Curvegrid prize.**

The demo should show card linking and World verification, wallet funding, merchant invoice creation, a physical card tap, and the confirmed receipt/dashboard activity. Show the matching Sepolia transaction and the MultiBaas contract/event view to make the integration visible to judges.
