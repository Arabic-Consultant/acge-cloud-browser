#!/usr/bin/env bash
# Points the dashboard at the current cloud browser runner (or clears it).
# Uses the Vercel API: set BROWSER_AGENT_URL on the project, then redeploy so the
# serverless functions receive the new environment.
set -euo pipefail

URL="${1:-}"
API="https://api.vercel.com"
TEAM="${VERCEL_TEAM:-arabic-consultants-projects}"
PROJECT="${VERCEL_PROJECT:-arabic-consultant-growth-engine}"
AUTH=(-H "authorization: Bearer ${VERCEL_TOKEN:?VERCEL_TOKEN is required}" -H "content-type: application/json")

PROJECT_ID="$(curl -fsSL "${AUTH[@]}" "$API/v9/projects/$PROJECT?teamId=$TEAM" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')"
echo "project: $PROJECT_ID"

ENV_ID="$(curl -fsSL "${AUTH[@]}" "$API/v9/projects/$PROJECT_ID/env?teamId=$TEAM" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const e=(j.envs||[]).find(x=>x.key==="BROWSER_AGENT_URL");console.log(e?e.id:"")})')"

BODY="$(node -e 'console.log(JSON.stringify({value:process.argv[1],type:"plain",target:["production","preview"]}))' "$URL")"
if [ -n "$ENV_ID" ]; then
  curl -fsSL -o /dev/null "${AUTH[@]}" -X PATCH "$API/v9/projects/$PROJECT_ID/env/$ENV_ID?teamId=$TEAM" -d "$BODY"
else
  curl -fsSL -o /dev/null "${AUTH[@]}" -X POST "$API/v10/projects/$PROJECT_ID/env?teamId=$TEAM&upsert=true" \
    -d "$(node -e 'const b=JSON.parse(process.argv[1]);b.key="BROWSER_AGENT_URL";console.log(JSON.stringify(b))' "$BODY")"
fi
echo "BROWSER_AGENT_URL set to '${URL}'"

# Redeploy production so functions pick up the value.
LATEST="$(curl -fsSL "${AUTH[@]}" "$API/v6/deployments?projectId=$PROJECT_ID&target=production&limit=1&teamId=$TEAM" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const d=(j.deployments||[])[0];console.log(d?d.uid:"")})')"
if [ -z "$LATEST" ]; then echo "no production deployment to redeploy"; exit 0; fi
curl -fsSL -o /dev/null "${AUTH[@]}" -X POST "$API/v13/deployments?teamId=$TEAM&forceNew=1" \
  -d "$(node -e 'console.log(JSON.stringify({name:process.argv[1],deploymentId:process.argv[2],target:"production"}))' "$PROJECT" "$LATEST")"
echo "redeploy triggered from $LATEST"
