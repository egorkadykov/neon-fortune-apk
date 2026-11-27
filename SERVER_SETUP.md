# Neon Fortune — защищённый сервер

Секрет GitHub больше **не вшивается в APK**. Игра обращается к Cloudflare Worker, а Worker хранит токен GitHub в своём секрете и обновляет общий файл `data/online-state.json`.

## 1. GitHub

1. Открой https://github.com/settings/personal-access-tokens → **Neon Fortune online data** → **Revoke**. Старый токен у друга больше не сработает.
2. Создай новый fine-grained token:
   - Resource owner: `egorkadykov`
   - Repository access: Only select repositories → `neon-fortune-apk`
   - Repository permissions → Contents: **Read and write**
   - Expiration: по желанию (например, 90 дней)
3. В репозитории `egorkadykov/neon-fortune-apk` → Settings → Secrets and variables → Actions:
   - Secret `NEON_API_TOKEN` = новый токен (используется только Worker).
   - Secret `CLOUDFLARE_API_TOKEN` = API-токен Cloudflare с правом `Workers Script:Edit`.
   - Secret `CLOUDFLARE_ACCOUNT_ID` = Account ID Cloudflare.
   - Variable `NEON_API_BASE` = адрес развёрнутого Worker, например `https://neon-fortune-api.ВАШ-ПОДДОМЕН.workers.dev`.

## 2. Cloudflare

1. Зарегистрируйся https://dash.cloudflare.com/sign-up (бесплатный план).
2. My Profile → API Tokens → Create Token → Use template **Edit Cloudflare Workers** (или вручную `Workers Script:Edit`).
3. Account ID виден на главной странице справа.
4.Workflow **Deploy Neon Fortune API** задеплоит `worker/` и передаст Worker секрет `GITHUB_TOKEN`.

## 3. Сборка APK

После того как variable `NEON_API_BASE` заполнена, запусти **Build Neon Fortune APK** (автоматически или вручную). В APK будет только публичный адрес сервера — никакого токена.

## Что защищено

- В APK нет секрета GitHub; разобрать APK и получить доступ нельзя.
- Публичный `/state` не отдаёт ни хэши паролей, ни сессионные токены.
- Каждый игрок меняет только свой профиль; сервер проверяет, что прирост баланса за одну запись не больше 100 000 (admin может править миллионы напрямую в файле).
- Старые APK с утечкой перестанут работать после отзыва токена.
