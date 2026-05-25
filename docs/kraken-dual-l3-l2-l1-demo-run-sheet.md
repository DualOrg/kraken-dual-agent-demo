# Kraken DUAL L3/L2/L1 Demo Run Sheet

Live app: <https://kraken-dual-agent-demo.vercel.app/>

Purpose: run a DUAL/USD paper trade, then show exactly where the DUAL evidence lives across the application, DUAL Console, L3 explorer, L2 explorer, and L1 roll-up view.

This run sheet is for the live demo surface. It is paper-only on Kraken execution, but the DUAL write/readback path is live when the top status shows `DUAL WRITE-SYNC LIVE`.

## 30-Second Frame

Say this before touching the controls:

> Kraken supplies the market venue. The app only performs paper execution. DUAL supplies the binding: mandate template, passport object, policy hash, action log, receipt action, batch proof, and settlement route from L3 to L2 to L1 roll-up.

Point to the top status chips:

- `MODE PAPER`: no real Kraken order is being placed.
- `DUAL WRITE-SYNC LIVE`: paper-trade evidence is being written to DUAL.
- `KRAKEN PUBLIC API LIVE`: market data is coming from Kraken public data.

## Run The Trade

1. Open <https://kraken-dual-agent-demo.vercel.app/>.
2. Confirm the trade form shows:
   - Pair: `DUALUSD`
   - Side: `buy`
   - Notional USD: `75`
3. Click `CHECK POLICY`.
4. Call out the mandate result:
   - `ALLOW`
   - `auto - under threshold`
   - `ready to execute`
5. Click `EXECUTE PAPER TRADE`.
6. Wait for the proposal panel to show:
   - `PAPER EXEC FILLED`
   - local receipt id
   - state `executed`

Presenter line:

> This is the moment the demo stops being a UI claim. The paper trade updates the DUAL passport object and enters the DUAL action/batch path.

## Where To Look In The App

Use the first screen. No scroll is required.

1. `LIVE TRADE`
   - Shows the paper trade intent, policy decision, and execution status.
   - This is the human-readable "what happened" panel.
2. `DUAL BINDING`
   - Shows the chain of evidence: template, passport object, policy hash, action log, receipt, batch proof.
   - Click the small `Console`, `L3`, `L2`, `L1 ROLL-UP`, or `Data` links depending on what you want to prove.
3. `LIVE PROOF`
   - Shows the compact proof readback and the `DUAL settlement path` rail.
   - This is the main presenter callout for `L3 action -> L2 batch -> L1 roll-up`.
4. `EVENT TRACE`
   - Shows the local action timeline: market snapshots, proposal, execution.
   - This helps explain the difference between local audit events and DUAL-anchored actions.

## The L3/L2/L1 Story

Say this:

> The action starts as a DUAL protocol-level action on L3. DUAL batches those actions into the DUAL Network L2. The L2 batch is the roll-up carrier for L1 settlement visibility.

Then point at the `DUAL settlement path` rail in `LIVE PROOF`.

### L3: Action Evidence

Where to click in the app:

- `LIVE PROOF -> DUAL settlement path -> L3 ACTION`
- Or `DUAL BINDING -> ACTION LOG -> L3`

What it proves:

- The governed action exists as a DUAL action hash.
- The action is tied back to the DUAL passport object and action log.

For the trade run captured on 2026-05-26 09:34 AEST, the trade batch included these L3 actions:

| Evidence | Action id | Action hash | Link |
| --- | --- | --- | --- |
| Trade execution update | `6a14dc68008d2cb5fb6f496e` | `0x21990d35904abc43a1db901a777225ccc2e0280994d79bb7969ff54be2eebecf` | <https://explorer-testnet.dual.network/actions/6a14dc68008d2cb5fb6f496e> |
| Receipt mint / latest proof action | `6a14dc68008d2cb5fb6f4973` | `0xbca854cddab05554db4c88039425a5c17f9e9dca5bd0e1ec2a5a71d736f7e11b` | <https://explorer-testnet.dual.network/actions/6a14dc68008d2cb5fb6f4973> |
| DUALUSD market readback action | `6a14dc57008d2cb5fb6f4966` | `0x4bd913074655ccf1decde9507774a91b1904518e9a2866ed9d52be5bc9bb7f46` | <https://explorer-testnet.dual.network/actions/6a14dc57008d2cb5fb6f4966> |

Console/action data links:

- Execution action console: <https://console-testnet.dual.network/69b935b4187e903f826bbe71/collections/action-logs?actionId=6a14dc68008d2cb5fb6f496e>
- Receipt action console: <https://console-testnet.dual.network/69b935b4187e903f826bbe71/collections/action-logs?actionId=6a14dc68008d2cb5fb6f4973>
- Latest proof action console: <https://console-testnet.dual.network/69b935b4187e903f826bbe71/collections/action-logs?actionId=6a14dc68008d2cb5fb6f4973>
- Latest proof action data: <https://kraken-dual-agent-demo.vercel.app/api/dual/records/actions/6a14dc68008d2cb5fb6f4973>

Note: use the L3 explorer action routes above. The L3 Data Explorer does not use Blockscout-style `/tx/{hash}` routes for DUAL action pages.

### L2: Batch Evidence

Where to click in the app:

- `LIVE PROOF -> DUAL settlement path -> L2 BATCH`
- Or `DUAL BINDING -> BATCH PROOF -> L2`

What it proves:

- DUAL batched the action set.
- The batch has a proof status and finality state.
- The batch has an L2 transaction hash on `explorer-test-v2.dual.network`.

Captured run:

- Batch id: `6a14dc6b5401ccd73824a83e`
- Status: `finalized`
- Finality: `finalized`
- Proof: `SUCCESS`
- Sequence: `346`
- Action count: `7`
- L2 transaction: `0xadbdedd5370abf65279e2fbd71c24776e9085544e3d1b6ce6a55093fdc579f49`
- L2 explorer: <https://explorer-test-v2.dual.network/tx/0xadbdedd5370abf65279e2fbd71c24776e9085544e3d1b6ce6a55093fdc579f49>
- Batch data readback: <https://kraken-dual-agent-demo.vercel.app/api/dual/records/batches/6a14dc6b5401ccd73824a83e>

### L1: Roll-Up Visibility

Where to click in the app:

- `LIVE PROOF -> DUAL settlement path -> L1 ROLL-UP`
- Or `DUAL BINDING -> BATCH PROOF -> L1 ROLL-UP`

What it proves:

- The demo has a visible roll-up path from DUAL's L2 batch.
- In this run, no separate L1 transaction hash was exposed in `/api/proof`; the app correctly shows L1 roll-up as `via L2` and links to the L2 transaction that carries the roll-up path.

Captured run:

- L1 roll-up status: `via L2`
- Roll-up carrier tx: `0xadbdedd5370abf65279e2fbd71c24776e9085544e3d1b6ce6a55093fdc579f49`
- Link to open: <https://explorer-test-v2.dual.network/tx/0xadbdedd5370abf65279e2fbd71c24776e9085544e3d1b6ce6a55093fdc579f49>

Presenter line:

> For L1, do not invent a separate hash. This run exposes L1 roll-up visibility through the L2 transaction. If a future batch exposes a distinct L1 hash, this same rail will point there.

## DUAL Console And Data Links

Use these when someone asks, "Is this really in DUAL?"

| Evidence | Link |
| --- | --- |
| DUAL org dashboard | <https://console-testnet.dual.network/69b935b4187e903f826bbe71> |
| Passport template | <https://console-testnet.dual.network/69b935b4187e903f826bbe71/collections/templates?templateId=69f9800d099fee32bfa12efb> |
| Passport object | <https://console-testnet.dual.network/69b935b4187e903f826bbe71/collections/objects?objectId=69f9800d099fee32bfa12efe> |
| Receipt template | <https://console-testnet.dual.network/69b935b4187e903f826bbe71/collections/templates?templateId=6a0fd5310379c9a69fb0afe9> |
| Proof bundle | <https://kraken-dual-agent-demo.vercel.app/api/proof> |
| Verifier | <https://kraken-dual-agent-demo.vercel.app/api/proof/verify> |

## Captured Trade Details

These values came from the live run performed with Computer Use on 2026-05-26 09:33-09:35 AEST and the production proof readback after the L3 route fix at 09:46 AEST.

| Field | Value |
| --- | --- |
| Pair | `DUALUSD` |
| Side | `buy` |
| Notional | `$75.00` |
| Price | `$0.005239` |
| Quantity | `14315.70910479 DUAL` |
| Proposal id | `prop-f12db387` |
| Local receipt id | `tr-228f596cea5b` |
| Passport object | `69f9800d099fee32bfa12efe` |
| Policy hash | `9d9885c2258e8b57b0176bcf511b314587c44cca998a4e1d2426d552990a8221` |
| Durable event pointer | `evt-48eb2d6a67` |
| Durable event hash | `48eb2d6a67ce41bf95ec1ad4274f1c32f594901a7432027ff69ac2a1b21f202b` |
| Proof hash | `f50a1e7e0480c312819716167ed7ab866e90f0fed48f49e0c4a4a90ea5f0944a` |
| Audit root | `ff0b1d17b26e762544bd42df74576a5c2675fcc5c6fcde816b02d1b3d64fdc6e` |
| Replay root | `dfd350bde247375244a179857a2918fbb3ae97d5b5dc7a0b99079aa22043d9fe` |

Verifier result:

- `ok: true`
- `complete: true`
- `status: complete`
- Replay queue: `0/1` pending in current production proof readback
- Latest batch check: `Latest DUAL batch 6a14dc6b5401ccd73824a83e is finalized; proof SUCCESS.`

## If Something Is Pending During A Live Demo

The network can be mid-batch when you click. Use this wording:

> The L3 action is already visible. The L2/L1 path is settling. The app keeps the explicit batch data link so we can refresh until the L2 transaction and roll-up pointer appear.

Then open:

- Batch data readback: <https://kraken-dual-agent-demo.vercel.app/api/dual/records/batches/6a14dc6b5401ccd73824a83e>
- Proof verifier: <https://kraken-dual-agent-demo.vercel.app/api/proof/verify>

## Close

End with:

> The trade is not the product. The binding is the product. DUAL lets an audience inspect the mandate, the policy decision, the action log, the receipt action, the L2 batch, and the L1 roll-up path after the agent acts.
