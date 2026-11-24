// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IssuerRegistry} from "./IssuerRegistry.sol";

/// @notice ERC-5192 minimal soulbound interface.
interface IERC5192 {
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);
    function locked(uint256 tokenId) external view returns (bool);
}

/// @title FanCredential - locked ERC-721 minted against an issuer-signed attestation
/// @notice "Issuer X recorded activity type T for identity commitment H at event E, per its own records."
///         No personal data on-chain. Anyone (e.g. a gas-sponsoring relayer) may submit the attestation;
///         only the issuer's registered key can authorise it.
contract FanCredential is ERC721, EIP712, IERC5192 {
    struct Attestation {
        uint256 issuerId;
        uint8 credType; // 1 = attendance, 2 = merch
        uint256 eventId;
        bytes32 identityCommitment;
        address holder;
        uint64 deadline;
    }

    struct Credential {
        uint256 issuerId;
        uint8 credType;
        uint256 eventId;
        bytes32 identityCommitment;
        uint64 issuedAt;
        uint32 epoch;
        bool revoked;
    }

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(uint256 issuerId,uint8 credType,uint256 eventId,bytes32 identityCommitment,address holder,uint64 deadline)"
    );

    IssuerRegistry public immutable registry;
    uint256 public totalMinted;
    mapping(uint256 => Credential) private _credentials;
    /// @dev keccak(issuerId, epoch, eventId, commitment) => tokenId (one credential per identity per event)
    mapping(bytes32 => uint256) public credentialOf;

    event CredentialIssued(uint256 indexed tokenId, uint256 indexed issuerId, uint256 indexed eventId, address holder, uint8 credType);
    event CredentialRevoked(uint256 indexed tokenId, address by);
    event CredentialBurned(uint256 indexed tokenId, address by);

    error Soulbound();
    error InvalidIssuerSignature();
    error IssuerNotActive();
    error AttestationExpired();
    error DuplicateCredential();
    error NotAuthorized();
    error UnknownCredential();

    constructor(IssuerRegistry registry_) ERC721("FanPassport Credential", "FANPASS") EIP712("FanPassport", "1") {
        registry = registry_;
    }

    // ------------------------------------------------------------- issuance

    function mint(Attestation calldata att, bytes calldata issuerSig) external returns (uint256 tokenId) {
        if (block.timestamp > att.deadline) revert AttestationExpired();
        if (!registry.isActive(att.issuerId)) revert IssuerNotActive();

        bytes32 structHash = keccak256(
            abi.encode(ATTESTATION_TYPEHASH, att.issuerId, att.credType, att.eventId, att.identityCommitment, att.holder, att.deadline)
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), issuerSig);
        if (signer != registry.keyOf(att.issuerId)) revert InvalidIssuerSignature();

        uint32 epoch = registry.epochOf(att.issuerId);
        bytes32 uniq = _uniqueKey(att.issuerId, epoch, att.eventId, att.identityCommitment);
        if (credentialOf[uniq] != 0) revert DuplicateCredential();

        tokenId = ++totalMinted;
        credentialOf[uniq] = tokenId;
        _credentials[tokenId] = Credential({
            issuerId: att.issuerId,
            credType: att.credType,
            eventId: att.eventId,
            identityCommitment: att.identityCommitment,
            issuedAt: uint64(block.timestamp),
            epoch: epoch,
            revoked: false
        });
        _safeMint(att.holder, tokenId);
        emit Locked(tokenId);
        emit CredentialIssued(tokenId, att.issuerId, att.eventId, att.holder, att.credType);
    }

    // ----------------------------------------------- revocation and burning

    function revoke(uint256 tokenId) external {
        Credential storage c = _existing(tokenId);
        _requireIssuerOrAdmin(c.issuerId);
        c.revoked = true;
        emit CredentialRevoked(tokenId, msg.sender);
    }

    /// @notice Used for wallet loss (re-issue after re-verification) and erasure requests.
    function burn(uint256 tokenId) external {
        Credential storage c = _existing(tokenId);
        _requireIssuerOrAdmin(c.issuerId);
        delete credentialOf[_uniqueKey(c.issuerId, c.epoch, c.eventId, c.identityCommitment)];
        delete _credentials[tokenId];
        _burn(tokenId);
        emit CredentialBurned(tokenId, msg.sender);
    }

    // ---------------------------------------------------------------- views

    function getCredential(uint256 tokenId) external view returns (Credential memory) {
        return _credentials[tokenId];
    }

    /// @notice exists, not revoked, issuer active, and minted under the issuer's current epoch
    function isValid(uint256 tokenId) public view returns (bool) {
        if (_ownerOf(tokenId) == address(0)) return false;
        Credential storage c = _credentials[tokenId];
        return !c.revoked && registry.isActive(c.issuerId) && c.epoch == registry.epochOf(c.issuerId);
    }

    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IERC5192).interfaceId || super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------- soulbound rules

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    /// @dev Only mint (from == 0) and burn (to == 0) may move a token.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    // -------------------------------------------------------------- helpers

    function _existing(uint256 tokenId) private view returns (Credential storage c) {
        if (_ownerOf(tokenId) == address(0)) revert UnknownCredential();
        c = _credentials[tokenId];
    }

    function _requireIssuerOrAdmin(uint256 issuerId) private view {
        if (msg.sender != registry.keyOf(issuerId) && msg.sender != registry.admin()) revert NotAuthorized();
    }

    function _uniqueKey(uint256 issuerId, uint32 epoch, uint256 eventId, bytes32 commitment) private pure returns (bytes32) {
        return keccak256(abi.encode(issuerId, epoch, eventId, commitment));
    }
}
