# Inbound gateway: how client data arrives and how to test it

## How Halcyon receives order data

From the problem statement and the dataset:

| Channel | Format | Share of orders | Problem today |
|---|---|---|---|
| API | JSON over HTTPS | 36% | Flows straight into the WMS unchecked (5% incomplete addresses) |
| EDI | ANSI X12 850 purchase orders | 32% | Same (5% incomplete addresses) |
| Email | Free text in 14 client layouts, sometimes CSV attachments | 32% | Typed in by hand by customer success: 28% incomplete addresses |

All three now go through one pipeline (`server/src/ingest`):

1. **Parse** the channel's format: MIME email with body, HTML, base64 / quoted-printable and CSV attachments; X12 850; JSON; CSV file drop.
2. **Normalise and auto-fix** predictable errors, recording each one: state names to codes, ZIPs that lost their leading zero, ZIP+4,
   service synonyms ("overnight", "same day please"), "40 units", SKU spacing, client-id format, casing.
3. **Validate** with stable issue codes: missing or invalid address parts, ZIP not in the state (with a suggestion), bad SKU or quantity,
   unknown client, duplicate PO, EDI structure errors.
4. **AI layer**: the client-profile anomaly screen (unusual time, channel or destination), late-risk score with reasons, cutoff-aware
   promise, and carrier choice within daily capacity.
5. **Decide**: `accepted`, `corrected` (accepted after auto-fixes), `held` (client must fix), `rejected`, or `duplicate`.
6. **Reply**: email gets a plain-English reply listing what was fixed and what to correct; EDI gets a 997; API gets a per-order JSON result.

## Test it yourself

The test pack lives in `ingest/test-data/`, one file per problem. Regenerate it with `npm run ingest:testdata`.

**Everything at once** (API must be running):

```bash
npm run ingest:test
```

**Email:** open the app at **Inbound gateway → Email**, pick a test email or upload any `.eml`, and click *Process email*.
Or drop the file into the watched folder, and its reply appears next to it in `inbox/processed/`:

```bash
cp ingest/test-data/email/04-state-name-and-lost-zip-zero.eml inbox/
```

**API:** client secrets for C055, C190 and C263 are in `ingest/test-data/credentials.json` (test only, git-ignored).
Interactive docs: http://localhost:4000/api/docs.

```bash
TOKEN=$(curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d "{\"client_id\":\"C055\",\"client_secret\":\"$(node -p "require('./ingest/test-data/credentials.json').C055")\"}" | node -p 'JSON.parse(require("fs").readFileSync(0)).access_token')
curl -s localhost:4000/api/v1/orders -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  --data @ingest/test-data/api/02-batch-every-error-type.json
```

**EDI:** `curl -s localhost:4000/api/ingest/edi -H 'content-type: application/edi-x12' --data-binary @ingest/test-data/edi/850-two-valid-orders.edi`

**Production email:** point your email provider's inbound-parse webhook at `POST /api/ingest/email/inbound`
(`{ from, subject, date, text, attachments }`); it runs the same pipeline.

Test files use `TP-` PO numbers. Re-sending the same file is correctly reported as a duplicate; the test runner and the UI's
*Fresh PO numbers* option add a unique prefix so files can be re-sent.
