// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IssuerRegistry - permissioned list of credential issuers and their doors
/// @notice Technical white paper, Table 2: issuer keys, status and epochs; admin-controlled;
///         timelocked key rotation. MVP admin = team multisig, planned handover to issuers.
contract IssuerRegistry {
    struct Issuer {
        address key;
        bool active;
        bool exists;
        uint32 epoch;
        string name;
    }

    struct PendingRotation {
        address newKey;
        uint64 executableAt;
    }

    uint64 public constant KEY_ROTATION_DELAY = 24 hours;

    address public admin;
    mapping(uint256 => Issuer) private _issuers;
    mapping(uint256 => PendingRotation) public pendingRotation;
    /// @notice door address => issuerId that operates it (0 = not a door)
    mapping(address => uint256) public doorIssuer;
    uint256[] public issuerIds;

    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event IssuerAdded(uint256 indexed issuerId, address key, string name);
    event IssuerSuspended(uint256 indexed issuerId);
    event IssuerReactivated(uint256 indexed issuerId);
    event EpochBumped(uint256 indexed issuerId, uint32 newEpoch);
    event KeyRotationProposed(uint256 indexed issuerId, address newKey, uint64 executableAt);
    event KeyRotated(uint256 indexed issuerId, address newKey);
    event DoorAdded(address indexed door, uint256 indexed issuerId);

    error NotAdmin();
    error NotAuthorized();
    error IssuerExists();
    error UnknownIssuer();
    error ZeroAddress();
    error TimelockActive();
    error NoPendingRotation();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    /// @dev the issuer's own key, or the admin
    modifier onlyIssuerOrAdmin(uint256 issuerId) {
        Issuer storage i = _issuers[issuerId];
        if (!i.exists) revert UnknownIssuer();
        if (msg.sender != i.key && msg.sender != admin) revert NotAuthorized();
        _;
    }

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        emit AdminTransferred(address(0), admin_);
    }

    // ---------------------------------------------------------------- admin

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function addIssuer(uint256 issuerId, address key, string calldata name) external onlyAdmin {
        if (issuerId == 0 || key == address(0)) revert ZeroAddress();
        if (_issuers[issuerId].exists) revert IssuerExists();
        _issuers[issuerId] = Issuer({key: key, active: true, exists: true, epoch: 1, name: name});
        issuerIds.push(issuerId);
        emit IssuerAdded(issuerId, key, name);
    }

    function suspendIssuer(uint256 issuerId) external onlyAdmin {
        if (!_issuers[issuerId].exists) revert UnknownIssuer();
        _issuers[issuerId].active = false;
        emit IssuerSuspended(issuerId);
    }

    function reactivateIssuer(uint256 issuerId) external onlyAdmin {
        if (!_issuers[issuerId].exists) revert UnknownIssuer();
        _issuers[issuerId].active = true;
        emit IssuerReactivated(issuerId);
    }

    // ------------------------------------------------------ issuer or admin

    /// @notice Compromise recovery: one transaction invalidates every credential of the issuer.
    function bumpEpoch(uint256 issuerId) external onlyIssuerOrAdmin(issuerId) {
        uint32 e = ++_issuers[issuerId].epoch;
        emit EpochBumped(issuerId, e);
    }

    function proposeKeyRotation(uint256 issuerId, address newKey) external onlyIssuerOrAdmin(issuerId) {
        if (newKey == address(0)) revert ZeroAddress();
        uint64 at = uint64(block.timestamp) + KEY_ROTATION_DELAY;
        pendingRotation[issuerId] = PendingRotation(newKey, at);
        emit KeyRotationProposed(issuerId, newKey, at);
    }

    /// @notice Anyone may execute a rotation once the timelock has passed.
    function executeKeyRotation(uint256 issuerId) external {
        PendingRotation memory p = pendingRotation[issuerId];
        if (p.newKey == address(0)) revert NoPendingRotation();
        if (block.timestamp < p.executableAt) revert TimelockActive();
        _issuers[issuerId].key = p.newKey;
        delete pendingRotation[issuerId];
        emit KeyRotated(issuerId, p.newKey);
    }

    function addDoor(address door, uint256 issuerId) external onlyIssuerOrAdmin(issuerId) {
        if (door == address(0)) revert ZeroAddress();
        doorIssuer[door] = issuerId;
        emit DoorAdded(door, issuerId);
    }

    // ---------------------------------------------------------------- views

    function getIssuer(uint256 issuerId) external view returns (Issuer memory) {
        return _issuers[issuerId];
    }

    function isActive(uint256 issuerId) external view returns (bool) {
        return _issuers[issuerId].active;
    }

    function keyOf(uint256 issuerId) external view returns (address) {
        return _issuers[issuerId].key;
    }

    function epochOf(uint256 issuerId) external view returns (uint32) {
        return _issuers[issuerId].epoch;
    }

    function issuerCount() external view returns (uint256) {
        return issuerIds.length;
    }
}
