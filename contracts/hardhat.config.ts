import { configVariable, defineConfig } from "hardhat/config";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatEthersChaiMatchers from "@nomicfoundation/hardhat-ethers-chai-matchers";
import hardhatMocha from "@nomicfoundation/hardhat-mocha";

export default defineConfig({
  plugins: [hardhatEthers, hardhatEthersChaiMatchers, hardhatMocha],
  paths: { sources: "./src" },
  solidity: {
    compilers: [
      {
        version: "0.8.33",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "paris",
        },
      },
    ],
    overrides: {
      // OpenZeppelin 5.6 ERC721 metadata helpers require MCOPY; Sepolia supports Cancun.
      // Keep the deployed MJPY and legacy DemoPayments on their original Paris settings.
      "src/RewardPayments.sol": {
        version: "0.8.33",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",
          viaIR: true,
        },
      },
      "src/CollectibleRewards.sol": {
        version: "0.8.33",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",
          viaIR: true,
        },
      },
      "src/LoyaltyPoints.sol": {
        version: "0.8.33",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",
          viaIR: true,
        },
      },
    },
  },
  networks: {
    testnet: {
      type: "http",
      chainType: "l1",
      url: configVariable("TESTNET_RPC_URL"),
      accounts: process.env.AWS_KMS_OPERATOR_KEY_ID
        ? []
        : process.env.DEPLOYER_PRIVATE_KEY
          ? [configVariable("DEPLOYER_PRIVATE_KEY")]
          : [],
    },
  },
});
