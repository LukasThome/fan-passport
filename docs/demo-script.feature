# Acceptance criteria for the PD3 MVP: Technical White Paper, Appendix A.
# Each scenario is automated twice: at contract level (test/contracts/demoScript.test.js)
# and end to end through the HTTP API used by the web app (test/api/demoScript.api.test.js).

Feature: Shared single-use redemption across two issuers and two doors
  As artists and promoters who do not trust each other's databases
  We want one shared record of which fan credentials were already used
  So that a credential admitted at one door is rejected at any other door

  Background:
    Given the admin registered "Issuer A" (attendance) and "Issuer B" (merch)
    And Door 1 is operated by Issuer A and Door 2 by Issuer B
    And joint drop "D1" accepts credentials from both issuers

  Scenario: Step 1 - an attendance record becomes a credential
    When Issuer A uploads its check-in CSV
    Then only checked-in, de-duplicated identities are eligible
    And a non-listed email is refused a claim link
    When Ana enters the one-time code and signs with her wallet
    Then the relayer mints a locked credential to Ana's Issuer-A address
    And no personal data is written on-chain

  Scenario: Step 2 - a second, independent issuer
    When Issuer B uploads its merch order CSV
    Then the order below $15 is rejected
    And Ana claims a merch credential at a different address

  Scenario: Step 3 - non-transferability
    When Ana tries to transfer a credential
    Then the transaction reverts with "Soulbound"

  Scenario: Step 4 - admission waits for the receipt
    Given Ana shows a fresh QR signed by her holder key at Door 1
    When staff match the name on Issuer A's record to her ID
    And Door 1 submits redeem() for D1
    Then Door 1 shows ADMIT only after the receipt shows success

  Scenario: Step 5 - shared state, no trust in the other issuer's server
    Given Door 1 already redeemed Ana's Issuer-A credential
    When the same still-fresh QR is shown at Door 2 seconds later
    Then Door 2 rejects it with "AlreadyRedeemed" citing Door 1's transaction
    And Door 2 does not name-check another issuer's credential
    And a forced redeem() is reverted by the contract itself

  Scenario: Step 6 - the second issuer's credential works independently
    When Ana shows her Issuer-B credential at Door 2
    Then Door 2 name-checks it against Issuer B's record and admits

  Scenario Outline: Step 7 - invalid scans are rejected
    When <situation>
    Then the door rejects it with "<reason>"

    Examples:
      | situation                                  | reason          |
      | credential A is scanned again              | AlreadyRedeemed |
      | Issuer A revoked credential A2 (refund)    | Revoked         |
      | the QR was signed more than 60 s ago       | ProofExpired    |
      | the QR was signed by someone else's key    | BadHolderProof  |

  Scenario: Step 9 - a compromised issuer key is contained
    Given Issuer B's signing key has leaked
    When the admin suspends Issuer B
    Then every door rejects Issuer B's credentials with "IssuerSuspended"
    When Issuer B bumps its epoch after the fix
    Then its old credentials are invalid with "StaleEpoch"
    When Issuer B re-attests the genuine credential under the new epoch
    Then the new credential is valid
    But it is still redeemed for drop D1, because single use follows the credential identity, not the token

  Scenario: Re-issue after a lost wallet cannot re-enter a drop
    Given a fan's credential was redeemed for D1 and the fan lost the wallet
    When the issuer burns it and re-issues the same identity to a new wallet
    Then the door rejects it with "AlreadyRedeemed", citing the original redemption

  Scenario: Step 10 - is the chain worth it?
    Given the gas used by this run's mints and redemptions, measured from their receipts
    When the costs of a reference drop (1,500 mints, 1,000 redemptions) are computed with stated price assumptions
    Then they are shown beside the white paper's worksheet: (a) signed credential + database vs (c) on-chain
    And for one artist, one seller and one door the answer is (a)
    And only with two or more distrusting issuers and doors does (c) add single use without a trusted operator
