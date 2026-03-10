jq -n --rawfile briefing briefing.txt \
  '{prompt: ("call getProducts with the following briefing and summarize in a table for me. Briefing:\n\n" + $briefing)}' \
| curl -N -X POST "http://localhost:3851/api/chat" \
  -H "Content-Type: application/json" \
  --data-binary @-
