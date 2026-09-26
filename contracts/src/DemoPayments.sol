// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Test-token router; backend authorizes invoices and the payer signs each transaction.
/// @dev Never put card identifiers or identity proofs in invoice or merchant identifiers.
contract DemoPayments is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Merchant {
        address recipient;
        bool enabled;
    }

    IERC20 public immutable token;
    mapping(bytes32 merchantId => Merchant merchant) public merchants;
    mapping(address payer => mapping(bytes32 invoiceId => bool settled)) public settled;

    error InvalidToken();
    error InvalidMerchant();
    error InvalidRecipient();
    error MerchantRecipientImmutable();
    error InvalidInvoice();
    error InvalidAmount();
    error InvoiceExpired();
    error MerchantDisabled();
    error InvoiceAlreadySettled();

    event MerchantUpdated(bytes32 indexed merchantId, address indexed recipient, bool enabled);
    event PaymentCompleted(
        bytes32 indexed invoiceId,
        bytes32 indexed merchantId,
        address indexed payer,
        address recipient,
        address token,
        uint256 amount
    );

    constructor(address token_, address administrator) Ownable(administrator) {
        if (token_ == address(0) || token_.code.length == 0) revert InvalidToken();
        token = IERC20(token_);
    }

    /// @notice Toggle eligibility; a recipient change requires a new merchant identifier.
    function setMerchant(bytes32 merchantId, address recipient, bool enabled) external onlyOwner {
        if (merchantId == bytes32(0)) revert InvalidMerchant();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        address registered = merchants[merchantId].recipient;
        if (registered != address(0) && registered != recipient) revert MerchantRecipientImmutable();
        merchants[merchantId] = Merchant(recipient, enabled);
        emit MerchantUpdated(merchantId, recipient, enabled);
    }

    /// @notice Pay an enabled merchant using an existing allowance from the calling wallet.
    function pay(bytes32 invoiceId, bytes32 merchantId, uint256 amount, uint256 expiresAt)
        external nonReentrant
    {
        if (invoiceId == bytes32(0)) revert InvalidInvoice();
        if (amount == 0) revert InvalidAmount();
        if (block.timestamp > expiresAt) revert InvoiceExpired();
        Merchant memory merchant = merchants[merchantId];
        if (!merchant.enabled) revert MerchantDisabled();
        if (settled[msg.sender][invoiceId]) revert InvoiceAlreadySettled();

        // A failed transfer reverts this write. Other payers cannot consume this invoice slot.
        settled[msg.sender][invoiceId] = true;
        token.safeTransferFrom(msg.sender, merchant.recipient, amount);
        emit PaymentCompleted(invoiceId, merchantId, msg.sender, merchant.recipient, address(token), amount);
    }
}
