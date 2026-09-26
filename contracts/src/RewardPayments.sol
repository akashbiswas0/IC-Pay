// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @notice MJPY payments with merchant-specific, non-transferable discount vouchers.
/// @dev Customer wallets sign transactions; terminal/identity/policy authorization stays in the backend.
contract RewardPayments is ERC721, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Merchant { address recipient; bool enabled; }
    struct Campaign {
        bool enabled;
        uint256 minPurchase;
        uint16 discountBps;
        uint256 maxDiscount;
        uint64 validitySeconds;
        uint64 version;
    }
    struct Voucher {
        bytes32 merchantId;
        address holder;
        uint256 minPurchase; // Earning threshold only; never a redemption minimum.
        uint16 discountBps;
        uint256 maxDiscount;
        uint64 campaignVersion;
        uint64 issuedAt;
        uint64 expiresAt;
        bool redeemed;
        uint64 redeemedAt;
        bytes32 issuedInvoiceId;
        bytes32 redeemedInvoiceId;
    }

    IERC20 public immutable token;
    uint256 public nextVoucherId = 1;
    mapping(bytes32 => Merchant) public merchants;
    mapping(bytes32 => Campaign) public campaigns;
    mapping(uint256 => Voucher) public vouchers;
    mapping(address => mapping(bytes32 => bool)) public settled;
    mapping(address => uint256[]) private _issuedVouchers;

    error InvalidToken();
    error InvalidMerchant();
    error InvalidRecipient();
    error MerchantRecipientImmutable();
    error InvalidInvoice();
    error InvalidAmount();
    error InvoiceExpired();
    error MerchantDisabled();
    error InvoiceAlreadySettled();
    error InvalidCampaign();
    error VoucherUnavailable();
    error WrongVoucherHolder();
    error WrongVoucherMerchant();
    error VoucherExpired();
    error ZeroDiscount();
    error NonTransferable();
    error InvalidPageSize();

    event MerchantUpdated(bytes32 indexed merchantId, address indexed recipient, bool enabled);
    event CampaignUpdated(bytes32 indexed merchantId, uint64 indexed version, bool enabled, uint256 minPurchase, uint16 discountBps, uint256 maxDiscount, uint64 validitySeconds);
    event PaymentCompleted(bytes32 indexed invoiceId, bytes32 indexed merchantId, address indexed payer, address recipient, address token, uint256 amount);
    event RewardIssued(uint256 indexed voucherId, address indexed payer, bytes32 indexed merchantId, bytes32 invoiceId, uint64 campaignVersion, uint256 minPurchase, uint16 discountBps, uint256 maxDiscount, uint64 expiresAt);
    event RewardRedeemed(uint256 indexed voucherId, address indexed payer, bytes32 indexed merchantId, bytes32 invoiceId, uint256 grossAmount, uint256 discount, uint256 netAmount);

    constructor(address token_, address administrator) ERC721("Suica Pay Rewards", "SPR") Ownable(administrator) {
        if (token_ == address(0) || token_.code.length == 0) revert InvalidToken();
        token = IERC20(token_);
    }

    function setMerchant(bytes32 merchantId, address recipient, bool enabled) external onlyOwner {
        if (merchantId == bytes32(0)) revert InvalidMerchant();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        address registered = merchants[merchantId].recipient;
        if (registered != address(0) && registered != recipient) revert MerchantRecipientImmutable();
        merchants[merchantId] = Merchant(recipient, enabled);
        emit MerchantUpdated(merchantId, recipient, enabled);
    }

    function setCampaign(bytes32 merchantId, bool enabled, uint256 minPurchase, uint16 discountBps, uint256 maxDiscount, uint64 validitySeconds) external onlyOwner {
        if (merchants[merchantId].recipient == address(0)) revert InvalidMerchant();
        if (minPurchase == 0 || discountBps == 0 || discountBps > 9999 || maxDiscount == 0 || validitySeconds == 0 || validitySeconds > 365 days) revert InvalidCampaign();
        uint64 version = campaigns[merchantId].version + 1;
        campaigns[merchantId] = Campaign(enabled, minPurchase, discountBps, maxDiscount, validitySeconds, version);
        emit CampaignUpdated(merchantId, version, enabled, minPurchase, discountBps, maxDiscount, validitySeconds);
    }

    function quotePayment(bytes32 merchantId, uint256 grossAmount) external view returns (bool earnsReward, uint64 campaignVersion) {
        if (!merchants[merchantId].enabled) revert MerchantDisabled();
        if (grossAmount == 0) revert InvalidAmount();
        Campaign memory campaign = campaigns[merchantId];
        return (campaign.enabled && grossAmount >= campaign.minPurchase, campaign.version);
    }

    function quoteReward(uint256 voucherId, address payer, bytes32 merchantId, uint256 grossAmount) public view returns (uint256 discount, uint256 netAmount) {
        if (grossAmount == 0) revert InvalidAmount();
        if (!merchants[merchantId].enabled) revert MerchantDisabled();
        Voucher storage voucher = vouchers[voucherId];
        if (voucher.holder == address(0) || voucher.redeemed) revert VoucherUnavailable();
        if (voucher.holder != payer) revert WrongVoucherHolder();
        if (voucher.merchantId != merchantId) revert WrongVoucherMerchant();
        if (block.timestamp > voucher.expiresAt) revert VoucherExpired();
        discount = Math.min(Math.mulDiv(grossAmount, voucher.discountBps, 10_000), voucher.maxDiscount);
        if (discount == 0) revert ZeroDiscount();
        if (discount >= grossAmount) revert InvalidAmount();
        netAmount = grossAmount - discount;
    }

    function pay(bytes32 invoiceId, bytes32 merchantId, uint256 grossAmount, uint256 expiresAt) external nonReentrant {
        Merchant memory merchant = _validatePayment(invoiceId, merchantId, grossAmount, expiresAt);
        Campaign memory campaign = campaigns[merchantId];
        settled[msg.sender][invoiceId] = true;
        token.safeTransferFrom(msg.sender, merchant.recipient, grossAmount);
        emit PaymentCompleted(invoiceId, merchantId, msg.sender, merchant.recipient, address(token), grossAmount);
        if (campaign.enabled && grossAmount >= campaign.minPurchase) _issueReward(invoiceId, merchantId, campaign);
    }

    function payWithReward(bytes32 invoiceId, bytes32 merchantId, uint256 grossAmount, uint256 expiresAt, uint256 voucherId) external nonReentrant {
        Merchant memory merchant = _validatePayment(invoiceId, merchantId, grossAmount, expiresAt);
        (uint256 discount, uint256 netAmount) = quoteReward(voucherId, msg.sender, merchantId, grossAmount);
        settled[msg.sender][invoiceId] = true;
        Voucher storage voucher = vouchers[voucherId];
        voucher.redeemed = true;
        voucher.redeemedAt = SafeCast.toUint64(block.timestamp);
        voucher.redeemedInvoiceId = invoiceId;
        _burn(voucherId);
        // Failed allowance/balance/transfer checks revert the burn, redemption record, and invoice atomically.
        token.safeTransferFrom(msg.sender, merchant.recipient, netAmount);
        emit PaymentCompleted(invoiceId, merchantId, msg.sender, merchant.recipient, address(token), netAmount);
        emit RewardRedeemed(voucherId, msg.sender, merchantId, invoiceId, grossAmount, discount, netAmount);
    }

    /// @notice Bounded issued-history pagination, including redeemed/expired vouchers for receipt displays.
    function issuedVoucherIds(address wallet, uint256 offset, uint256 limit) external view returns (uint256[] memory voucherIds, uint256 total) {
        if (limit == 0 || limit > 50) revert InvalidPageSize();
        uint256[] storage history = _issuedVouchers[wallet];
        total = history.length;
        if (offset >= total) return (new uint256[](0), total);
        uint256 count = Math.min(limit, total - offset);
        voucherIds = new uint256[](count);
        for (uint256 i; i < count; ++i) voucherIds[i] = history[offset + i];
    }

    function approve(address, uint256) public pure override { revert NonTransferable(); }
    function setApprovalForAll(address, bool) public pure override { revert NonTransferable(); }
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0) && to != address(0)) revert NonTransferable();
        return super._update(to, tokenId, auth);
    }

    /// @notice Issued metadata remains readable after burn; balances/ownerOf retain standard ERC721 semantics.
    function tokenURI(uint256 voucherId) public view override returns (string memory) {
        Voucher storage voucher = vouchers[voucherId];
        if (voucher.holder == address(0)) revert ERC721NonexistentToken(voucherId);
        string memory status = voucher.redeemed ? "redeemed" : block.timestamp > voucher.expiresAt ? "expired" : "available";
        return string.concat("data:application/json;base64,", Base64.encode(bytes(string.concat(
            '{"name":"Suica Pay reward #', Strings.toString(voucherId),
            '","description":"Non-transferable merchant discount. No cash value.","attributes":[',
            '{"trait_type":"Merchant","value":"', Strings.toHexString(uint256(voucher.merchantId), 32), '"},',
            '{"trait_type":"Discount basis points","value":', Strings.toString(voucher.discountBps), '},',
            '{"trait_type":"Maximum discount base units","value":"', Strings.toString(voucher.maxDiscount), '"},',
            '{"trait_type":"Expires at","value":', Strings.toString(voucher.expiresAt), '},',
            '{"trait_type":"Campaign version","value":', Strings.toString(voucher.campaignVersion), '},',
            '{"trait_type":"Status","value":"', status, '"}]}'
        ))));
    }

    function _validatePayment(bytes32 invoiceId, bytes32 merchantId, uint256 grossAmount, uint256 expiresAt) private view returns (Merchant memory merchant) {
        if (invoiceId == bytes32(0)) revert InvalidInvoice();
        if (grossAmount == 0) revert InvalidAmount();
        if (block.timestamp > expiresAt) revert InvoiceExpired();
        merchant = merchants[merchantId];
        if (!merchant.enabled) revert MerchantDisabled();
        if (settled[msg.sender][invoiceId]) revert InvoiceAlreadySettled();
    }

    function _issueReward(bytes32 invoiceId, bytes32 merchantId, Campaign memory campaign) private {
        uint256 voucherId = nextVoucherId++;
        uint64 issuedAt = SafeCast.toUint64(block.timestamp);
        uint64 expiresAt = SafeCast.toUint64(block.timestamp + campaign.validitySeconds);
        vouchers[voucherId] = Voucher(merchantId, msg.sender, campaign.minPurchase, campaign.discountBps, campaign.maxDiscount, campaign.version, issuedAt, expiresAt, false, 0, invoiceId, bytes32(0));
        _issuedVouchers[msg.sender].push(voucherId);
        _safeMint(msg.sender, voucherId);
        emit RewardIssued(voucherId, msg.sender, merchantId, invoiceId, campaign.version, campaign.minPurchase, campaign.discountBps, campaign.maxDiscount, expiresAt);
    }
}
