# Deploying to Azure App Service

The app runs on Azure App Service (Windows, Node 24 LTS) on the existing **ASP-rgsagoodsreceipt-9c97**
plan (Basic B1, Australia East). GitHub Actions deploys it on every push to `main`, using
[.github/workflows/deploy.yml](.github/workflows/deploy.yml).

| Item              | Value                                        |
|-------------------|----------------------------------------------|
| Subscription      | Pay-As-You-Go BH AMEX                        |
| Resource group    | `rg-sa-goods-receipt`                        |
| App Service plan  | `ASP-rgsagoodsreceipt-9c97` (Windows, B1)    |
| Web app           | `sa-availability`                            |
| URL               | <https://sa-availability.azurewebsites.net>  |
| Data              | `D:\home\data` (persistent, survives redeploys) |
| Deploy identity   | `id-sa-availability-deploy` (managed identity, GitHub OIDC) |

## How it runs on Windows App Service

- IIS hands every request to `server.js` through iisnode ([web.config](web.config)). iisnode passes
  `PORT` as a named pipe path, which `server.js` handles.
- `flushResponse` is on and compression is off, so live updates (Server-Sent Events) are not buffered.
- Events and live connections are held in memory, so the app **must run as a single instance with a
  single Node process**. Don't scale the app out, and leave `nodeProcessCountPerApplication="1"`.
- `D:\home` is persistent storage shared by the app's instances. `DATA_DIR` points there rather than
  at `wwwroot`, so deployments never touch saved events.

## One-time setup

Run these once, in Bash (Git Bash or Cloud Shell), with the Azure CLI signed in to the right
subscription and the GitHub CLI signed in to the `spectrum-automation` org.

```bash
SUB=5d7ee97d-5c8e-4e29-807b-e9f9d8e0b306
RG=rg-sa-goods-receipt
PLAN=ASP-rgsagoodsreceipt-9c97
APP=sa-availability
ID=id-sa-availability-deploy
REPO=spectrum-automation/spectrumautomation-availability

az account set --subscription $SUB
```

### 1. Create the web app

```bash
az webapp create -g $RG -p $PLAN -n $APP --runtime "NODE:24LTS"

az webapp config appsettings set -g $RG -n $APP --settings \
  DATA_DIR='D:\home\data' \
  WEBSITE_NODE_DEFAULT_VERSION='~24'

az webapp config set -g $RG -n $APP \
  --always-on true \
  --use-32bit-worker-process false \
  --http20-enabled true \
  --min-tls-version 1.2 \
  --ftps-state Disabled

az webapp update -g $RG -n $APP --https-only true --client-affinity-enabled false
```

**Always On** keeps the Node process loaded, so events stay cached and live connections aren't
dropped when the app goes idle.

### 2. Let GitHub Actions deploy without a stored password

GitHub signs in to Azure with OIDC as a user-assigned managed identity. The identity can only
manage this one web app, and only workflow runs using the `production` environment can use it.

```bash
az identity create -g $RG -n $ID -l australiaeast

az identity federated-credential create -g $RG --identity-name $ID -n github-production \
  --issuer https://token.actions.githubusercontent.com \
  --subject repo:$REPO:environment:production \
  --audiences api://AzureADTokenExchange

az role assignment create \
  --assignee-object-id "$(az identity show -g $RG -n $ID --query principalId -o tsv)" \
  --assignee-principal-type ServicePrincipal \
  --role "Website Contributor" \
  --scope "$(az webapp show -g $RG -n $APP --query id -o tsv)"
```

### 3. Configure the GitHub repository

```bash
gh api -X PUT repos/$REPO/environments/production

gh secret set AZURE_CLIENT_ID       --env production -R $REPO -b "$(az identity show -g $RG -n $ID --query clientId -o tsv)"
gh secret set AZURE_TENANT_ID       --env production -R $REPO -b "$(az account show --query tenantId -o tsv)"
gh secret set AZURE_SUBSCRIPTION_ID --env production -R $REPO -b "$SUB"
```

In **Settings → Environments → production** you can optionally add required reviewers or limit
deployments to the `main` branch.

### 4. Deploy

Push to `main`, or run **Deploy to Azure App Service** from the Actions tab. The workflow
syntax-checks the code, packages `server.js`, `package.json`, `web.config` and `public/`, and
zip-deploys them.

### 5. Move existing events (optional)

To carry over events from a local `data/` folder, upload the `*.json` files to `D:\home\data` using
the Kudu file browser (<https://sa-availability.scm.azurewebsites.net/DebugConsole>), then restart:

```bash
az webapp restart -g $RG -n $APP
```

## Operations

- **Logs.** Turn on application logging with
  `az webapp log config -g $RG -n $APP --application-logging filesystem --level information`,
  then stream it with `az webapp log tail -g $RG -n $APP`. iisnode also writes stdout/stderr to
  `D:\home\site\wwwroot\iisnode` (visible in Kudu).
- **Backups.** Saved events are the JSON files in `D:\home\data`. Basic tier includes App Service
  automatic backups of the app's content. For a copy you control, schedule a download of that
  folder or configure a custom backup to a storage account.
- **Custom domain.** Add a CNAME to `sa-availability.azurewebsites.net`, then
  `az webapp config hostname add` and bind a free managed certificate. Sharing links keep working
  because the front end uses relative URLs.
- **Restarts** clear the in-memory cache only. Events reload from disk and open pages reconnect on
  their own.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Live status stays on "Reconnecting…" or updates arrive late | Response buffering: check `flushResponse="true"` and that compression is off in `web.config`. |
| Password prompt shows a generic IIS error page | `httpErrors existingResponse="PassThrough"` missing from `web.config`. |
| Events vanish after a deploy | `DATA_DIR` not set, so data went to `wwwroot\data`. Set it to `D:\home\data`. |
| Different people see different data | More than one instance or Node process. Keep instance count and `nodeProcessCountPerApplication` at 1. |
| Deploy fails at "Sign in to Azure" | Federated credential subject must be exactly `repo:spectrum-automation/spectrumautomation-availability:environment:production`. |
