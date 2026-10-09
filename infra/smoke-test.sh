#!/usr/bin/env bash
# Post-deploy smoke test (public checks only; needs no credentials).
#   infra/smoke-test.sh https://<render-url> https://<owner>.github.io/<repo>
set -u
API="${1:?API url}"; APP="${2:?app url}"; ORIGIN="$(printf '%s' "$APP" | sed -E 's#(https?://[^/]+).*#\1#')"
ok=0; bad=0
check() { if eval "$2"; then echo "PASS $1"; ok=$((ok+1)); else echo "FAIL $1"; bad=$((bad+1)); fi; }
check "API /healthz is 200"            "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $API/healthz)\" = 200 ]"
check "API /readyz (database) is 200"  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $API/readyz)\" = 200 ]"
check "API docs are OFF in production" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $API/docs)\" = 404 ]"
check "protected route needs a login"  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $API/api/v1/me)\" = 401 ]"
check "unknown payment link is the generic 404" "curl -s $API/api/v1/public/pay/not-a-real-token-1234 | grep -q 'unavailable'"
check "CORS allows the app origin"     "curl -s -i -X OPTIONS $API/api/v1/me -H 'Origin: $ORIGIN' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization' | grep -qi \"access-control-allow-origin: $ORIGIN\""
check "CORS refuses another origin"    "! curl -s -i -X OPTIONS $API/api/v1/me -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: GET' | grep -qi 'access-control-allow-origin: https://evil.example'"
check "app loads (HTTP 200)"           "[ \"\$(curl -s -o /dev/null -w '%{http_code}' $APP/)\" = 200 ]"
check "app bundle has no backend secret names" "! curl -s $APP/ | grep -Eqi 'SERVICE_ROLE_KEY|TOKEN_ENC_KEY'"
echo "$ok passed, $bad failed"; [ "$bad" = 0 ]
