// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice Merchant-specific, non-transferable purchase points. One whole point discounts one token.
/// @dev No tokens/NFTs are minted by this router. Point units use the payment token's decimal precision.
contract LoyaltyPoints is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant EXPIRY_BUCKETS = 367;
    uint256 private constant DAY = 1 days;
    struct Merchant { address recipient; bool enabled; }
    struct Campaign { bool enabled; uint256 minPurchase; uint16 earnBps; uint256 maxEarnPoints; uint64 validitySeconds; uint64 version; }
    struct Lot { uint64 expiresAt; uint256 units; }
    struct SpentLot { uint64 expiresAt; uint192 units; }
    struct Account {
        mapping(uint256 => Lot) lots;
        uint256 occupiedLow;
        uint256 occupiedHigh;
        uint256 debtUnits;
        uint256 earnedUnits;
        uint256 redeemedPoints;
        uint256 expiredUnits;
        uint256 restoredUnits;
        uint256 reversedUnits;
    }
    struct Payment {
        bytes32 merchantId;
        address recipient;
        uint256 grossAmount;
        uint256 netAmount;
        uint256 redeemedPoints;
        uint256 earnedUnits;
        uint256 debtRepaid;
        uint64 earnedExpiresAt;
        uint64 campaignVersion;
        uint16 earnBps;
        uint256 maxEarnPoints;
        uint64 createdAt;
        bool refunded;
    }
    IERC20 public immutable token;
    uint256 public immutable pointUnit;
    mapping(bytes32 => Merchant) public merchants;
    mapping(bytes32 => Campaign) public campaigns;
    mapping(address => mapping(bytes32 => bool)) public settled;
    mapping(address => mapping(bytes32 => Payment)) public payments;
    mapping(address => mapping(bytes32 => Account)) private _accounts;
    mapping(address => mapping(bytes32 => SpentLot[])) private _spentLots;
    mapping(address => bytes32[]) private _walletMerchants;
    mapping(bytes32 => address[]) private _merchantWallets;
    mapping(address => mapping(bytes32 => bool)) private _known;

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
    error InsufficientPoints();
    error InvalidPointRedemption();
    error InvalidPageSize();
    error InvalidBucket();
    error UnknownPayment();
    error UnauthorizedRefund();
    error AlreadyRefunded();
    error SelfPayment();

    event MerchantUpdated(bytes32 indexed merchantId,address indexed recipient,bool enabled);
    event CampaignUpdated(bytes32 indexed merchantId,uint64 indexed version,bool enabled,uint256 minPurchase,uint16 earnBps,uint256 maxEarnPoints,uint64 validitySeconds);
    event PaymentCompleted(bytes32 indexed invoiceId,bytes32 indexed merchantId,address indexed payer,address recipient,address token,uint256 amount);
    event PointsEarned(bytes32 indexed invoiceId,bytes32 indexed merchantId,address indexed payer,uint256 tokenAmount,uint256 earnedUnits,uint256 debtRepaid,uint64 expiresAt,uint64 campaignVersion);
    event PointsRedeemed(bytes32 indexed invoiceId,bytes32 indexed merchantId,address indexed payer,uint256 points,uint256 discount);
    event PointsExpired(bytes32 indexed merchantId,address indexed payer,uint256 expiredUnits);
    event PaymentRefunded(bytes32 indexed invoiceId,bytes32 indexed merchantId,address indexed payer,address recipient,address token,uint256 amount,uint256 pointsRestoredUnits,uint256 earnedReversedUnits,uint256 debtUnits);

    constructor(address token_,address administrator) Ownable(administrator) {
        if (token_ == address(0) || token_.code.length == 0) revert InvalidToken();
        uint8 decimals = IERC20Metadata(token_).decimals();
        if (decimals > 36) revert InvalidToken();
        token = IERC20(token_);
        pointUnit = 10 ** uint256(decimals);
    }
    function setMerchant(bytes32 merchantId,address recipient,bool enabled) external onlyOwner {
        if (merchantId == bytes32(0)) revert InvalidMerchant();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        address registered = merchants[merchantId].recipient;
        if (registered != address(0) && registered != recipient) revert MerchantRecipientImmutable();
        merchants[merchantId] = Merchant(recipient,enabled);
        emit MerchantUpdated(merchantId,recipient,enabled);
    }
    function setCampaign(bytes32 merchantId,bool enabled,uint256 minPurchase,uint16 earnBps,uint256 maxEarnPoints,uint64 validitySeconds) external onlyOwner {
        if (merchants[merchantId].recipient == address(0)) revert InvalidMerchant();
        if (minPurchase == 0 || earnBps == 0 || earnBps > 10000 || maxEarnPoints == 0 || maxEarnPoints > type(uint256).max / pointUnit || validitySeconds < 60 || validitySeconds > 365 days) revert InvalidCampaign();
        uint64 version = campaigns[merchantId].version + 1;
        campaigns[merchantId] = Campaign(enabled,minPurchase,earnBps,maxEarnPoints,validitySeconds,version);
        emit CampaignUpdated(merchantId,version,enabled,minPurchase,earnBps,maxEarnPoints,validitySeconds);
    }
    function pointsBalance(address payer,bytes32 merchantId) public view returns(uint256 availablePoints,uint256 fractionalUnits,uint256 debtUnits,uint64 nextExpiryAt) {
        Account storage a = _accounts[payer][merchantId];
        (uint256 active,,uint64 next) = _balances(a);
        uint256 usable = active > a.debtUnits ? active - a.debtUnits : 0;
        return (usable / pointUnit,usable % pointUnit,a.debtUnits,next);
    }
    function pointsSummary(address payer,bytes32 merchantId) external view returns(uint256 earnedUnits,uint256 redeemedPoints,uint256 expiredUnits,uint256 restoredUnits,uint256 reversedUnits,uint256 debtUnits,uint256 activeUnits) {
        Account storage a = _accounts[payer][merchantId];
        (uint256 active,uint256 expired,) = _balances(a);
        return (a.earnedUnits,a.redeemedPoints,a.expiredUnits + expired,a.restoredUnits,a.reversedUnits,a.debtUnits,active);
    }
    function quotePoints(address payer,bytes32 merchantId,uint256 grossAmount,uint256 maxPoints) external view returns(uint256 pointsUsed,uint256 discount,uint256 netAmount) {
        if (grossAmount == 0) revert InvalidAmount();
        if (!merchants[merchantId].enabled) revert MerchantDisabled();
        (uint256 available,,,) = pointsBalance(payer,merchantId);
        pointsUsed = Math.min(maxPoints,Math.min(type(uint192).max / pointUnit,Math.min(available,grossAmount / pointUnit)));
        discount = pointsUsed * pointUnit;
        netAmount = grossAmount - discount;
    }
    function pay(bytes32 invoiceId,bytes32 merchantId,uint256 grossAmount,uint256 expiresAt) external nonReentrant {
        _pay(invoiceId,merchantId,grossAmount,expiresAt,0);
    }
    function payWithPoints(bytes32 invoiceId,bytes32 merchantId,uint256 grossAmount,uint256 expiresAt,uint256 pointsToRedeem) external nonReentrant {
        if (pointsToRedeem == 0) revert InvalidPointRedemption();
        _pay(invoiceId,merchantId,grossAmount,expiresAt,pointsToRedeem);
    }
    function _pay(bytes32 invoiceId,bytes32 merchantId,uint256 grossAmount,uint256 expiresAt,uint256 pointsToRedeem) private {
        if (invoiceId == bytes32(0)) revert InvalidInvoice();
        if (grossAmount == 0) revert InvalidAmount();
        if (block.timestamp > expiresAt) revert InvoiceExpired();
        Merchant memory merchant = merchants[merchantId];
        if (!merchant.enabled) revert MerchantDisabled();
        if (msg.sender == merchant.recipient) revert SelfPayment();
        if (settled[msg.sender][invoiceId]) revert InvoiceAlreadySettled();
        if (pointsToRedeem > grossAmount / pointUnit || pointsToRedeem > type(uint192).max / pointUnit) revert InvalidPointRedemption();
        settled[msg.sender][invoiceId] = true;
        _touch(msg.sender,merchantId);
        uint256 discount = pointsToRedeem * pointUnit;
        if (pointsToRedeem > 0) {
            _spend(msg.sender,merchantId,invoiceId,pointsToRedeem);
            emit PointsRedeemed(invoiceId,merchantId,msg.sender,pointsToRedeem,discount);
        }
        uint256 net = grossAmount - discount;
        if (net > 0) token.safeTransferFrom(msg.sender,merchant.recipient,net);
        Campaign memory campaign = campaigns[merchantId];
        Payment storage p = payments[msg.sender][invoiceId];
        p.merchantId = merchantId; p.recipient = merchant.recipient;
        p.grossAmount = grossAmount; p.netAmount = net; p.redeemedPoints = pointsToRedeem;
        p.campaignVersion = campaign.version; p.earnBps = campaign.earnBps; p.maxEarnPoints = campaign.maxEarnPoints;
        p.createdAt = SafeCast.toUint64(block.timestamp);
        if (campaign.enabled && net >= campaign.minPurchase) {
            p.earnedUnits = Math.min(Math.mulDiv(net,campaign.earnBps,10000),campaign.maxEarnPoints * pointUnit);
            if (p.earnedUnits > 0) {
                p.earnedExpiresAt = SafeCast.toUint64(((block.timestamp + campaign.validitySeconds + DAY - 1) / DAY) * DAY);
                p.debtRepaid = _credit(msg.sender,merchantId,p.earnedUnits,p.earnedExpiresAt);
                _accounts[msg.sender][merchantId].earnedUnits += p.earnedUnits;
                emit PointsEarned(invoiceId,merchantId,msg.sender,net,p.earnedUnits,p.debtRepaid,p.earnedExpiresAt,campaign.version);
            }
        }
        emit PaymentCompleted(invoiceId,merchantId,msg.sender,merchant.recipient,address(token),net);
    }
    /// @notice Full invoice refund only. The original merchant must supply the actual net payment tokens.
    /// @dev Expired earnings are waived except for the part that previously repaid point debt.
    function refund(bytes32 invoiceId,address payer) external nonReentrant {
        Payment storage p = payments[payer][invoiceId];
        if (p.recipient == address(0)) revert UnknownPayment();
        if (msg.sender != p.recipient) revert UnauthorizedRefund();
        if (p.refunded) revert AlreadyRefunded();
        p.refunded = true;
        Account storage a = _accounts[payer][p.merchantId];
        uint256 reversed = p.debtRepaid;
        a.debtUnits += p.debtRepaid;
        if (p.earnedExpiresAt > block.timestamp) {
            uint256 credited = p.earnedUnits - p.debtRepaid;
            Lot storage earnedLot = a.lots[(uint256(p.earnedExpiresAt) / DAY) % EXPIRY_BUCKETS];
            uint256 removed = earnedLot.expiresAt == p.earnedExpiresAt ? Math.min(earnedLot.units,credited) : 0;
            earnedLot.units -= removed;
            if (earnedLot.units == 0) _clearSlot(a,(uint256(p.earnedExpiresAt) / DAY) % EXPIRY_BUCKETS);
            a.debtUnits += credited - removed;
            reversed += credited;
        }
        a.reversedUnits += reversed;
        SpentLot[] storage spent = _spentLots[payer][invoiceId];
        uint256 restored;
        for (uint256 i; i < spent.length; ++i) {
            if (spent[i].expiresAt > block.timestamp) {
                restored += spent[i].units;
                _credit(payer,p.merchantId,spent[i].units,spent[i].expiresAt);
            }
        }
        a.restoredUnits += restored;
        if (p.netAmount > 0) token.safeTransferFrom(msg.sender,payer,p.netAmount);
        emit PaymentRefunded(invoiceId,p.merchantId,payer,p.recipient,address(token),p.netAmount,restored,reversed,a.debtUnits);
    }
    function walletMerchantIds(address payer,uint256 offset,uint256 limit) external view returns(bytes32[] memory merchantIds,uint256 total) {
        _page(limit); bytes32[] storage list = _walletMerchants[payer]; total = list.length;
        uint256 count = offset >= total ? 0 : Math.min(limit,total - offset);
        merchantIds = new bytes32[](count); for(uint256 i; i < count; ++i) merchantIds[i] = list[offset+i];
    }
    function merchantWallets(bytes32 merchantId,uint256 offset,uint256 limit) external view returns(address[] memory wallets,uint256 total) {
        _page(limit); address[] storage list = _merchantWallets[merchantId]; total = list.length;
        uint256 count = offset >= total ? 0 : Math.min(limit,total - offset);
        wallets = new address[](count); for(uint256 i; i < count; ++i) wallets[i] = list[offset+i];
    }
    function pointLots(address payer,bytes32 merchantId,uint256 offset,uint256 limit) external view returns(uint64[] memory expiries,uint256[] memory units) {
        _page(limit); if(offset >= EXPIRY_BUCKETS) revert InvalidBucket();
        uint256 count = Math.min(limit,EXPIRY_BUCKETS-offset);
        expiries = new uint64[](count); units = new uint256[](count);
        for(uint256 i; i<count; ++i) { Lot storage lot = _accounts[payer][merchantId].lots[offset+i]; expiries[i]=lot.expiresAt; units[i]=lot.units; }
    }
    /// @notice Permissionless bounded housekeeping. Views already exclude expired points.
    function expirePoints(address payer,bytes32 merchantId,uint256 offset,uint256 limit) external nonReentrant {
        _page(limit); if(offset >= EXPIRY_BUCKETS) revert InvalidBucket();
        uint256 count = Math.min(limit,EXPIRY_BUCKETS-offset);
        for(uint256 i; i<count; ++i) _expire(payer,merchantId,offset+i);
    }
    function _page(uint256 limit) private pure { if(limit == 0 || limit > 50) revert InvalidPageSize(); }
    function _touch(address payer,bytes32 merchantId) private {
        if (!_known[payer][merchantId]) { _known[payer][merchantId]=true; _walletMerchants[payer].push(merchantId); _merchantWallets[merchantId].push(payer); }
    }
    function _setSlot(Account storage a,uint256 slot) private {
        if(slot<256) a.occupiedLow |= uint256(1)<<slot;
        else a.occupiedHigh |= uint256(1)<<(slot-256);
    }
    function _clearSlot(Account storage a,uint256 slot) private {
        if(slot<256) a.occupiedLow &= ~(uint256(1)<<slot);
        else a.occupiedHigh &= ~(uint256(1)<<(slot-256));
    }
    function _balances(Account storage a) private view returns(uint256 active,uint256 expired,uint64 next) {
        // Two bitmaps avoid charging every ordinary customer for 367 empty storage reads.
        for(uint256 word; word<2; ++word) {
            uint256 bits = word==0 ? a.occupiedLow : a.occupiedHigh;
            while(bits!=0) {
                uint256 slot = Math.log2(bits & (~bits + 1)) + word*256;
                Lot storage lot = a.lots[slot];
                if(lot.expiresAt <= block.timestamp) expired += lot.units;
                else { active += lot.units; if(next == 0 || lot.expiresAt < next) next=lot.expiresAt; }
                bits &= bits-1;
            }
        }
    }
    function _expire(address payer,bytes32 merchantId,uint256 slot) private {
        Account storage a = _accounts[payer][merchantId]; Lot storage lot=a.lots[slot];
        if(lot.units>0 && lot.expiresAt<=block.timestamp) {uint256 expired=lot.units; lot.units=0; _clearSlot(a,slot); a.expiredUnits+=expired; emit PointsExpired(merchantId,payer,expired);}
    }
    function _credit(address payer,bytes32 merchantId,uint256 units,uint64 expiresAt) private returns(uint256 debtRepaid) {
        Account storage a=_accounts[payer][merchantId];
        debtRepaid=Math.min(units,a.debtUnits); a.debtUnits-=debtRepaid; units-=debtRepaid;
        if(units==0) return debtRepaid;
        uint256 slot=(uint256(expiresAt)/DAY)%EXPIRY_BUCKETS;
        _expire(payer,merchantId,slot);
        Lot storage lot=a.lots[slot];
        if(lot.units>0 && lot.expiresAt!=expiresAt) revert InvalidBucket();
        lot.expiresAt=expiresAt; lot.units+=units; _setSlot(a,slot);
    }
    function _spend(address payer,bytes32 merchantId,bytes32 invoiceId,uint256 points) private {
        Account storage a=_accounts[payer][merchantId];
        (uint256 available,,,) = pointsBalance(payer,merchantId);
        if(points>available) revert InsufficientPoints();
        uint256 remaining=points*pointUnit;
        uint256 first=block.timestamp/DAY+1;
        uint256 low=a.occupiedLow; uint256 high=a.occupiedHigh;
        // UTC expiry days are at most 366 days ahead; chronological fixed-ring traversal is bounded.
        for(uint256 i; i<EXPIRY_BUCKETS && remaining>0; ++i) {
            uint256 slot=(first+i)%EXPIRY_BUCKETS;
            if((slot<256 ? low & (uint256(1)<<slot) : high & (uint256(1)<<(slot-256)))==0) continue;
            Lot storage lot=a.lots[slot];
            if(lot.units==0 || lot.expiresAt<=block.timestamp) continue;
            uint256 taken=Math.min(remaining,lot.units); lot.units-=taken; remaining-=taken;
            if(lot.units==0) _clearSlot(a,slot);
            _spentLots[payer][invoiceId].push(SpentLot(lot.expiresAt,SafeCast.toUint192(taken)));
        }
        if(remaining!=0) revert InsufficientPoints();
        a.redeemedPoints+=points;
    }
}
