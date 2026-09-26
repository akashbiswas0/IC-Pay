// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
/// @dev Real issuer-controlled ERC20 used solely by local decimal-boundary tests.
contract DecimalToken is ERC20, Ownable {
    uint8 private immutable _precision;
    constructor(uint8 precision) ERC20("Decimal test token","DTT") Ownable(msg.sender) { _precision=precision; }
    function decimals() public view override returns(uint8) {return _precision;}
    function mint(address recipient,uint256 value) external onlyOwner {_mint(recipient,value);}
}
