// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISignatureTransfer} from "./vendor/ISignatureTransfer.sol";

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/**
 * @title SparseSettlementProxy
 * @notice Verifier for sparse (probabilistic) settlement over Permit2. A fork of x402UptoPermit2Proxy's structure:
 *         the buyer signs a Permit2 transfer for the ticket value `T` with this contract as spender and a witness
 *         binding payee, facilitator, price, odds, the facilitator's commitment and the purchase. The transfer of `T`
 *         happens iff the facilitator reveals the committed secret and `H(d ‖ s) < p / T · 2^128`, where `d` is the
 *         EIP-712 digest the buyer signed. Otherwise nothing moves and nobody else can move it.
 *
 * @dev The four invariants of the paper (§3.1):
 *      1. sole spender — the permit's spender is this contract, and only `witness.facilitator` may call `settle`;
 *      2. conditional transfer — funds move only if `keccak256(s) == commitment` and the roll is below the threshold;
 *      3. advertised odds are settled odds — `witness.threshold` is recomputed from `price` and `permitted.amount`;
 *      4. one purchase, one roll — `challengeId` is inside the signed witness (the client-side rule lives off-chain).
 *
 *      Settle-time price may be at or below the signed price (an `upTo` route fulfils for less): the odds fall, never rise.
 *
 * Experimental. Unaudited. Not deployed.
 */
contract SparseSettlementProxy {
    ISignatureTransfer public immutable PERMIT2;

    string public constant WITNESS_TYPE_STRING =
        "SparseWitness witness)SparseWitness(address to,address facilitator,uint256 price,uint256 threshold,bytes32 commitment,bytes32 challengeId,uint256 validAfter)TokenPermissions(address token,uint256 amount)";

    bytes32 public constant WITNESS_TYPEHASH = keccak256(
        "SparseWitness(address to,address facilitator,uint256 price,uint256 threshold,bytes32 commitment,bytes32 challengeId,uint256 validAfter)"
    );

    bytes32 private constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    string private constant PERMIT_WITNESS_TRANSFER_FROM_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

    uint256 private constant TWO_128 = 1 << 128;

    struct SparseWitness {
        address to;
        address facilitator;
        uint256 price;
        uint256 threshold;
        bytes32 commitment;
        bytes32 challengeId;
        uint256 validAfter;
    }

    event Settled(bytes32 indexed challengeId, address indexed payer, address indexed to, uint256 ticket, uint256 price);

    error InvalidPermit2Address();
    error InvalidDestination();
    error InvalidOwner();
    error UnauthorizedFacilitator();
    error NotYetValid();
    error CommitmentMismatch();
    error ThresholdMismatch();
    error PriceAboveSigned();
    error PriceTooLarge();
    error ZeroTicket();
    error NotAWinner();
    error Reentrancy();

    uint256 private _entered = 1;

    modifier nonReentrant() {
        if (_entered != 1) revert Reentrancy();
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor(address permit2) {
        if (permit2 == address(0)) revert InvalidPermit2Address();
        PERMIT2 = ISignatureTransfer(permit2);
    }

    /// @notice floor(price / ticket · 2^128); 2^128 when price ≥ ticket (every roll wins: deterministic settlement).
    function thresholdFor(uint256 price, uint256 ticket) public pure returns (uint256) {
        if (ticket == 0) revert ZeroTicket();
        if (price >= ticket) return TWO_128;
        if (price >= TWO_128) revert PriceTooLarge();
        return (price << 128) / ticket;
    }

    /// @notice The EIP-712 digest the buyer signed, recomputed the way Permit2 computes it, with this contract as spender.
    function digestOf(ISignatureTransfer.PermitTransferFrom calldata permit, bytes32 witnessHash) public view returns (bytes32) {
        bytes32 typeHash = keccak256(abi.encodePacked(PERMIT_WITNESS_TRANSFER_FROM_STUB, WITNESS_TYPE_STRING));
        bytes32 tokenPermissionsHash = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted));
        bytes32 structHash = keccak256(abi.encode(typeHash, tokenPermissionsHash, address(this), permit.nonce, permit.deadline, witnessHash));
        return keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(address(PERMIT2)).DOMAIN_SEPARATOR(), structHash));
    }

    function witnessHashOf(SparseWitness calldata witness) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                WITNESS_TYPEHASH,
                witness.to,
                witness.facilitator,
                witness.price,
                witness.threshold,
                witness.commitment,
                witness.challengeId,
                witness.validAfter
            )
        );
    }

    /**
     * @notice Settle a sparse ticket. Reverts unless the ticket won at `price`.
     * @param permit   The Permit2 transfer authorization for the ticket value `T` (`permitted.amount`).
     * @param owner    The payer.
     * @param witness  What the payer signed over.
     * @param signature The payer's Permit2 signature.
     * @param secret   The facilitator's secret; `keccak256(secret)` must equal `witness.commitment`.
     * @param price    The price actually charged; at most `witness.price`.
     */
    function settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        SparseWitness calldata witness,
        bytes calldata signature,
        bytes32 secret,
        uint256 price
    ) external nonReentrant {
        if (msg.sender != witness.facilitator) revert UnauthorizedFacilitator();
        if (witness.to == address(0)) revert InvalidDestination();
        if (owner == address(0)) revert InvalidOwner();
        if (block.timestamp < witness.validAfter) revert NotYetValid();
        if (keccak256(abi.encodePacked(secret)) != witness.commitment) revert CommitmentMismatch();
        if (witness.threshold != thresholdFor(witness.price, permit.permitted.amount)) revert ThresholdMismatch();
        if (price > witness.price) revert PriceAboveSigned();

        uint256 threshold = price == witness.price ? witness.threshold : thresholdFor(price, permit.permitted.amount);
        bytes32 witnessHash = witnessHashOf(witness);
        bytes32 digest = digestOf(permit, witnessHash);
        uint256 roll = uint256(keccak256(abi.encodePacked(digest, secret))) >> 128;
        if (roll >= threshold) revert NotAWinner();

        PERMIT2.permitWitnessTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({to: witness.to, requestedAmount: permit.permitted.amount}),
            owner,
            witnessHash,
            WITNESS_TYPE_STRING,
            signature
        );

        emit Settled(witness.challengeId, owner, witness.to, permit.permitted.amount, price);
    }
}
