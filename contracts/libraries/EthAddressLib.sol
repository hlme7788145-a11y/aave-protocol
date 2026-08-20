pragma solidity ^0.5.0;

library EthAddressLib {

    /**
    * @dev returns the address used within the protocol to identify ETH
    * @return the address assigned to ETH
     */
    function ethAddress() internal pure returns(address) {
        return 0xc89b563D925438FeDA28Af05Ac2dBAc2314B8eB4;
    }
}
