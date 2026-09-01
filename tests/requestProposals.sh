jq -n --rawfile briefing briefing.txt \
  '{prompt: ("Find proposals for the following briefing and summarize them in a table for me, including every proposal_id and terms_digest. Briefing:\n\n" + $briefing)}' \
| curl -N -X POST "http://localhost:3851/api/chat" \
  -H "Content-Type: application/json" \
  --data-binary @-
