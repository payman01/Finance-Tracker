# ============================================================
#  Finance Tracker — Azure + GitHub Deployment Script
#  Run with: pwsh ./deploy-to-azure.ps1
# ============================================================

# ── Config ──────────────────────────────────────────────────
$GITHUB_USERNAME = "payman01"
$REPO_NAME       = "finance-tracker"
$AZURE_LOCATION  = "eastus2"
# ────────────────────────────────────────────────────────────

$RESOURCE_GROUP = "rg-finance-tracker"
$APP_NAME       = "swa-finance-tracker-$(Get-Random -Maximum 9999)"

function Log($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Err($msg) { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }

# ============================================================
# STEP 1 — Prerequisites
# ============================================================
Log "Checking prerequisites..."

# ── Xcode Command Line Tools ──
/usr/bin/xcode-select -p 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Log "Installing Xcode Command Line Tools..."
    /usr/bin/touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
    $cltPkg = (softwareupdate -l 2>&1) |
        Select-String 'Command Line Tools for Xcode' |
        ForEach-Object { ($_ -replace '.*\* Label: ', '').Trim() } |
        Select-Object -Last 1
    if ($cltPkg) {
        softwareupdate --install $cltPkg --verbose
        if ($LASTEXITCODE -ne 0) { Err "CLT install failed. Install Xcode from the App Store then re-run." }
    } else {
        /bin/rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
        Write-Host "`n  Install Xcode from the App Store then re-run." -ForegroundColor Red
        exit 1
    }
    /bin/rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
}
Write-Host "  Xcode CLT : OK" -ForegroundColor Green

# ── Homebrew — find by file path, not by PATH ──
$BREW = $null
foreach ($candidate in @("/opt/homebrew/bin/brew", "/usr/local/bin/brew")) {
    if (Test-Path $candidate) { $BREW = $candidate; break }
}

if (-not $BREW) {
    Log "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    foreach ($candidate in @("/opt/homebrew/bin/brew", "/usr/local/bin/brew")) {
        if (Test-Path $candidate) { $BREW = $candidate; break }
    }
    if (-not $BREW) { Err "Homebrew installed but binary not found at /opt/homebrew/bin/brew or /usr/local/bin/brew." }
}

$BREW_BIN = Split-Path $BREW -Parent          # e.g. /opt/homebrew/bin
$env:PATH = "${BREW_BIN}:$env:PATH"
Write-Host "  Homebrew  : $BREW" -ForegroundColor Green

# ── Azure CLI ──
$AZ = Join-Path $BREW_BIN "az"
if (-not (Test-Path $AZ)) {
    Log "Installing Azure CLI..."
    & $BREW install azure-cli
    if ($LASTEXITCODE -ne 0) { Err "Azure CLI install failed." }
}
Write-Host "  Azure CLI : $(& $AZ version --query '\"azure-cli\"' -o tsv)" -ForegroundColor Green

# ── GitHub CLI ──
$GH = Join-Path $BREW_BIN "gh"
if (-not (Test-Path $GH)) {
    Log "Installing GitHub CLI..."
    & $BREW install gh
    if ($LASTEXITCODE -ne 0) { Err "GitHub CLI install failed." }
}
Write-Host "  GitHub CLI: $(& $GH --version | Select-Object -First 1)" -ForegroundColor Green
Write-Host "  git       : $(git --version)" -ForegroundColor Green

# ============================================================
# STEP 2 — Authenticate
# ============================================================
Log "Logging in to Azure (browser will open)..."
& $AZ login --output none
if ($LASTEXITCODE -ne 0) { Err "Azure login failed." }
$SUBSCRIPTION_ID = & $AZ account show --query id -o tsv
Write-Host "  Subscription: $SUBSCRIPTION_ID" -ForegroundColor Green

Log "GitHub authentication via Personal Access Token..."
Write-Host ""
Write-Host "  Create a PAT at: https://github.com/settings/tokens/new" -ForegroundColor Yellow
Write-Host "  Required scopes: repo, workflow, read:org" -ForegroundColor Yellow
Write-Host ""
$GH_TOKEN = Read-Host "  Paste your GitHub Personal Access Token here"
if (-not $GH_TOKEN) { Err "No token provided." }

$GH_TOKEN | & $GH auth login --hostname github.com --git-protocol https --with-token
if ($LASTEXITCODE -ne 0) { Err "GitHub login failed. Ensure token has repo, workflow, read:org scopes." }
Write-Host "  GitHub token: accepted" -ForegroundColor Green

# ============================================================
# STEP 3 — GitHub repo + branches
# ============================================================
Log "Creating GitHub repository '$REPO_NAME'..."
& $GH repo create "$GITHUB_USERNAME/$REPO_NAME" `
    --public `
    --description "Finance Tracker deployed to Azure Static Web Apps" 2>$null

Push-Location $PSScriptRoot

git checkout main 2>$null
git branch -D dev 2>$null
git init -b main 2>$null
git remote remove origin 2>$null
git remote add origin "https://$GH_TOKEN@github.com/$GITHUB_USERNAME/$REPO_NAME.git"

git add index.html staticwebapp.config.json .github/
if (git status --porcelain) {
    git commit -m "Initial commit: Finance Tracker static web app"
} else {
    Write-Host "  Nothing new to commit — using existing HEAD." -ForegroundColor Yellow
}

Log "Pushing to 'dev' branch..."
git checkout -b dev 2>$null
git push -u origin dev --force
if ($LASTEXITCODE -ne 0) { Err "Failed to push to dev branch." }
Write-Host "  Pushed to dev." -ForegroundColor Green

Log "Merging dev -> main and pushing..."
git checkout main
git merge dev --no-ff -m "Merge dev into main: initial release"
git push -u origin main --force
if ($LASTEXITCODE -ne 0) { Err "Failed to push to main." }
Write-Host "  Pushed to main." -ForegroundColor Green

& $GH api "repos/$GITHUB_USERNAME/$REPO_NAME/branches/main/protection" `
    --method PUT `
    --field required_status_checks='{"strict":true,"contexts":["Build and Deploy"]}' `
    --field enforce_admins=false `
    --field required_pull_request_reviews='{"required_approving_review_count":1}' `
    --field restrictions='null' 2>$null
Write-Host "  Branch protection set on main." -ForegroundColor Green

Pop-Location

# ============================================================
# STEP 4 — Azure resources
# ============================================================
Log "Creating Resource Group '$RESOURCE_GROUP' (skips if already exists)..."
& $AZ group create --name $RESOURCE_GROUP --location $AZURE_LOCATION --output none 2>$null
Write-Host "  Resource group ready." -ForegroundColor Green

# Reuse existing SWA if one already exists in this resource group
$EXISTING_SWA = & $AZ staticwebapp list `
    --resource-group $RESOURCE_GROUP `
    --query "[0].name" -o tsv 2>$null
if ($EXISTING_SWA) {
    $APP_NAME = $EXISTING_SWA
    Write-Host "  Reusing existing Static Web App: $APP_NAME" -ForegroundColor Green
} else {
    Log "Creating Azure Static Web App '$APP_NAME'..."
    & $AZ staticwebapp create `
        --name $APP_NAME `
        --resource-group $RESOURCE_GROUP `
        --source "https://github.com/$GITHUB_USERNAME/$REPO_NAME" `
        --location $AZURE_LOCATION `
        --branch main `
        --app-location "/" `
        --output-location "/" `
        --token $GH_TOKEN `
        --sku Free `
        --output json
    if ($LASTEXITCODE -ne 0) { Err "Failed to create Static Web App." }
    Write-Host "  Static Web App created." -ForegroundColor Green
}

$DEPLOY_URL   = & $AZ staticwebapp show `
    --name $APP_NAME `
    --resource-group $RESOURCE_GROUP `
    --query defaultHostname -o tsv
$DEPLOY_TOKEN = & $AZ staticwebapp secrets list `
    --name $APP_NAME `
    --resource-group $RESOURCE_GROUP `
    --query "properties.apiKey" -o tsv
Write-Host "  URL: https://$DEPLOY_URL" -ForegroundColor Yellow

# ============================================================
# STEP 5 — Azure Storage Account (strongly consistent, ~$0/month)
# ============================================================
$STORAGE_NAME = "stfintracker$(Get-Random -Maximum 9999)"
Log "Creating Azure Storage Account '$STORAGE_NAME'..."
& $AZ storage account create `
    --name $STORAGE_NAME `
    --resource-group $RESOURCE_GROUP `
    --location $AZURE_LOCATION `
    --sku Standard_LRS `
    --kind StorageV2 `
    --output none
if ($LASTEXITCODE -ne 0) { Err "Failed to create Storage Account." }
Write-Host "  Storage Account created (~\$0/month for this usage)." -ForegroundColor Green

$STORAGE_CONN = & $AZ storage account show-connection-string `
    --name $STORAGE_NAME `
    --resource-group $RESOURCE_GROUP `
    --query connectionString -o tsv
Write-Host "  Connection string retrieved." -ForegroundColor Green

# ============================================================
# STEP 6 — Push secrets to GitHub + wire into Static Web App
# ============================================================
Log "Adding secrets to GitHub and Static Web App..."

& $GH secret set AZURE_STATIC_WEB_APPS_API_TOKEN `
    --repo "$GITHUB_USERNAME/$REPO_NAME" `
    --body $DEPLOY_TOKEN
& $GH secret set STORAGE_CONNECTION_STRING `
    --repo "$GITHUB_USERNAME/$REPO_NAME" `
    --body $STORAGE_CONN

# Wire STORAGE_CONNECTION_STRING as an app setting so Azure Functions can read it
& $AZ staticwebapp appsettings set `
    --name $APP_NAME `
    --resource-group $RESOURCE_GROUP `
    --setting-names "STORAGE_CONNECTION_STRING=$STORAGE_CONN" `
    --output none
Write-Host "  Secrets set (GitHub + Static Web App)." -ForegroundColor Green

# ============================================================
# STEP 7 — Push updated code (sync.js + api/ + workflow)
# ============================================================
Log "Pushing updated code with Cosmos DB integration..."
Push-Location $PSScriptRoot
git add sync.js api/ index.html .github/workflows/azure-deploy.yml
git commit -m "feat: add Azure Cosmos DB cloud sync via Azure Functions" 2>$null
git push origin main
Pop-Location
Write-Host "  Code pushed — CI/CD will redeploy automatically." -ForegroundColor Green

# ============================================================
# STEP 8 — Trigger CI/CD run
# ============================================================
Log "Triggering CI/CD run..."
& $GH workflow run azure-deploy.yml --repo "$GITHUB_USERNAME/$REPO_NAME" --ref main 2>$null
Start-Sleep -Seconds 3
& $GH run list --repo "$GITHUB_USERNAME/$REPO_NAME" --limit 5

# ============================================================
# Done
# ============================================================
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " Deployment Complete!"                   -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host " App URL     : https://$DEPLOY_URL"
Write-Host " GitHub Repo : https://github.com/$GITHUB_USERNAME/$REPO_NAME"
Write-Host " Azure RG    : $RESOURCE_GROUP"
Write-Host " Storage     : $STORAGE_NAME"
Write-Host ""
Write-Host " Data is stored in Azure Table Storage."
Write-Host " Multi-device: share your Sync Code shown in the app (bottom-right)."
Write-Host " CI/CD: every push to dev or main auto-deploys."
Write-Host "========================================" -ForegroundColor Green
