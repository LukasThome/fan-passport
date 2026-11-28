// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IssuerRegistry} from "./IssuerRegistry.sol";
import {FanCredential} from "./FanCredential.sol";

/// @title RedemptionGate - drops and single-use state shared by every door
/// @notice redeem() checks the holder's proof, validity and accepted issuer, then sets the redeemed flag once.
///         This shared compare-and-set is the one thing the chain adds over a signed credential plus a
///         database: two doors from different issuers cannot both redeem one credential, and neither needs
///         the other's permission (technical white paper, section 5.3).
contract RedemptionGate is EIP712 {
    struct Drop {
        bool exists;
        uint256[] acceptedIssuers;
    }

    bytes32 public constant HOLDER_PROOF_TYPEHASH = keccak256("HolderProof(uint256 credentialId,uint256 dropId,uint64 issuedAt)");
    /// @notice rotating QR refreshes every 30 s; a proof is accepted for 60 s
    uint64 public constant PROOF_TTL = 60;
    /// @notice tolerated clock skew between the fan's phone and the chain
    uint64 public constant MAX_CLOCK_SKEW = 30;

    IssuerRegistry public immutable registry;
    FanCredential public immutable credential;

    mapping(uint256 => Drop) private _drops;
    mapping(uint256 => mapping(uint256 => bool)) private _accepted; // dropId => issuerId => accepted
    /// @dev dropId => identity key => redeemed. Keyed by the credential's identity (issuer, event,
    ///      commitment), not its tokenId, so re-issuance (epoch re-attestation, wallet loss) cannot reset it.
    mapping(uint256 => mapping(bytes32 => bool)) private _redeemed;

    event DropCreated(uint256 indexed dropId, uint256[] acceptedIssuers);
    event Redeemed(uint256 indexed credentialId, uint256 indexed dropId, address indexed door, uint256 issuerId, bytes32 identityKey);

    error NotAdmin();
    error DropExists();
    error UnknownDrop();
    error NotADoor();
    error IssuerNotAccepted();
    error CredentialNotValid();
    error ProofExpired();
    error BadHolderProof();
    error AlreadyRedeemed(uint256 credentialId, uint256 dropId);

    constructor(IssuerRegistry registry_, FanCredential credential_) EIP712("FanPassport", "1") {
        registry = registry_;
        credential = credential_;
    }

    /// @notice MVP: joint-drop consent is mocked by a single drop creator (the registry admin).
    function createDrop(uint256 dropId, uint256[] calldata acceptedIssuers) external {
        if (msg.sender != registry.admin()) revert NotAdmin();
        if (_drops[dropId].exists) revert DropExists();
        _drops[dropId].exists = true;
        _drops[dropId].acceptedIssuers = acceptedIssuers;
        for (uint256 i = 0; i < acceptedIssuers.length; i++) _accepted[dropId][acceptedIssuers[i]] = true;
        emit DropCreated(dropId, acceptedIssuers);
    }

    /// @notice Called by a door. The door must admit only after the receipt of this call shows success.
    function redeem(uint256 credentialId, uint256 dropId, uint64 issuedAt, bytes calldata holderSig) external {
        if (!_drops[dropId].exists) revert UnknownDrop();
        uint256 doorIssuerId = registry.doorIssuer(msg.sender);
        if (doorIssuerId == 0 || !_accepted[dropId][doorIssuerId]) revert NotADoor();
        FanCredential.Credential memory c = credential.getCredential(credentialId);
        bytes32 key = identityKey(c.issuerId, c.eventId, c.identityCommitment);
        if (_redeemed[dropId][key]) revert AlreadyRedeemed(credentialId, dropId);

        if (!credential.isValid(credentialId)) revert CredentialNotValid();
        uint256 issuerId = c.issuerId;
        if (!_accepted[dropId][issuerId]) revert IssuerNotAccepted();

        if (issuedAt > block.timestamp + MAX_CLOCK_SKEW || block.timestamp > issuedAt + PROOF_TTL) revert ProofExpired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(HOLDER_PROOF_TYPEHASH, credentialId, dropId, issuedAt)));
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, holderSig);
        if (err != ECDSA.RecoverError.NoError || signer != credential.ownerOf(credentialId)) revert BadHolderProof();

        _redeemed[dropId][key] = true;
        emit Redeemed(credentialId, dropId, msg.sender, issuerId, key);
    }

    // ---------------------------------------------------------------- views

    function isRedeemed(uint256 dropId, uint256 credentialId) external view returns (bool) {
        FanCredential.Credential memory c = credential.getCredential(credentialId);
        if (c.issuerId == 0) return false; // unknown or burned token
        return _redeemed[dropId][identityKey(c.issuerId, c.eventId, c.identityCommitment)];
    }

    function identityKey(uint256 issuerId, uint256 eventId, bytes32 commitment) public pure returns (bytes32) {
        return keccak256(abi.encode(issuerId, eventId, commitment));
    }

    function isAccepted(uint256 dropId, uint256 issuerId) external view returns (bool) {
        return _accepted[dropId][issuerId];
    }

    function getDrop(uint256 dropId) external view returns (bool exists, uint256[] memory acceptedIssuers) {
        Drop storage d = _drops[dropId];
        return (d.exists, d.acceptedIssuers);
    }
}
