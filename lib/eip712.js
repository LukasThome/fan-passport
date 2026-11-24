// EIP-712 definitions shared by the server, tests and (copied in) the browser PWA.
const attestationTypes = {
  Attestation: [
    { name: "issuerId", type: "uint256" },
    { name: "credType", type: "uint8" },
    { name: "eventId", type: "uint256" },
    { name: "identityCommitment", type: "bytes32" },
    { name: "holder", type: "address" },
    { name: "deadline", type: "uint64" },
  ],
};

/** The rotating QR: a challenge signed by the holder key, refreshed every 30 s. */
const holderProofTypes = {
  HolderProof: [
    { name: "credentialId", type: "uint256" },
    { name: "dropId", type: "uint256" },
    { name: "issuedAt", type: "uint64" },
  ],
};

function domainFor(chainId, verifyingContract) {
  return { name: "FanPassport", version: "1", chainId: Number(chainId), verifyingContract };
}

const bindMessage = (holder, token) => `FanPassport: bind ${holder} to claim ${token}`;
const codeRequestMessage = (tokenId, dropId, issuedAt) => `FanPassport code request ${tokenId} ${dropId} ${issuedAt}`;

module.exports = { attestationTypes, holderProofTypes, domainFor, bindMessage, codeRequestMessage };
