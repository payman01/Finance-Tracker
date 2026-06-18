# ============================================================
#  Finance Tracker — Full Azure + GitHub Deployment Script
#  Run with: pwsh ./deploy-to-azure.ps1
#  Prerequisites installed automatically by this script.
# ============================================================

# ── Config — edit these three variables ─────────────────────
$GITHUB_USERNAME   = "payman01"   # e.g. "paymanafshari"
$REPO_NAME         = "finance-tracker"
$AZURE_LOCATION    = "eastus"                 # nearest Azure region
# ────────────────────────────────────────────────────────────

$RESOURCE_GROUP    = "rg-finance-tracker"
$APP_NAME          = "swa-finance-tracker-$(Get-Random -Maximum 9999)"

# Helpers
function Log($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Err($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# ============================================================
# STEP 1 — Install prerequisites
# ============================================================
Log "Checking prerequisites..."

# Always ensure Homebrew bin dirs are in PATH for this session
$env:PATH = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$env:PATH"

# ── Xcode Command Line Tools (required for git and Homebrew) ──
/usr/bin/xcode-select -p 2>/dev/null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Log "Installing Xcode Command Line Tools via softwareupdate..."
    /usr/bin/touch /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
    $cltPkg = softwareupdate -l 2>&1 |
        Select-String 'Command Line Tools for Xcode' |
        ForEach-Object { ($_ -replace '.*\* Label: ', '').Trim() } |
        Select-Object -Last 1
    if ($cltPkg) {
        Write-Host "  Installing: $cltPkg" -ForegroundColor Yellow
        softwareupdate --install $cltPkg --verbose
        if ($LASTEXITCODE -ne 0) { Err "CLT install failed. See manual steps below." }
    } else {
        /bin/rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
        Write-Host ""
        Write-Host "  *** MANUAL STEP REQUIRED ***" -ForegroundColor Red
        Write-Host "  1. Open the App Store and install 'Xcode' (free), OR" -ForegroundColor Yellow
        Write-Host "  2. Download CLT from: https://developer.apple.com/download/all/" -ForegroundColor Yellow
        Write-Host "  Then re-run this script." -ForegroundColor Yellow
        exit 1
    }
    /bin/rm -f /tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
}
Write-Host "  Xcode CLT : OK" -ForegroundColor Green

# ── Homebrew ──
if (-not (Get-Command brew -ErrorAction SilentlyContinue)) {
    Log "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if ($LASTEXITCODE -ne 0) { Err "Homebrew installation failed." }
    $env:PATH = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$env:PATH"
    Write-Host "  Homebrew installed." -ForegroundColor Green
}

# ── Azure CLI ──
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Log "Installing Azure CLI via Homebrew..."
    brew install azure-cli
    if ($LASTEXITCODE -ne 0) { Err "Azure CLI installation failed." }
    $env:PATH = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$env:PATH"
}

# ── GitHub CLI ──
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Log "Installing GitHub CLI via Homebrew..."
    brew install gh
    if ($LASTEXITCODE -ne 0) { Err "GitHub CLI installation failed." }
    $env:PATH = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$env:PATH"
}

Write-Host "  Azure CLI : $(az version --query '\"azure-cli\"' -o tsv)" -ForegroundColor Green
Write-Host "  GitHub CLI: $(gh --version | Select-Object -First 1)" -ForegroundColor Green
Write-Host "  git       : $(git --version)" -ForegroundColor Green

# ============================================================
# STEP 2 — Authenticate Azure & GitHub
# ============================================================
Log "Logging in to Azure (browser will open)..."
az login --output none
if ($LASTEXITCODE -ne 0) { Err "Azure login failed." }

$SUBSCRIPTION_ID = az account show --query id -o tsv
Write-Host "  Subscription: $SUBSCRIPTION_ID" -ForegroundColor Green

Log "Logging in to GitHub (browser will open)..."
gh auth login --hostname github.com --git-protocol https --web
if ($LASTEXITCODE -ne 0) { Err "GitHub login failed." }

# ============================================================
# STEP 3 — Create GitHub Repository (main + dev branches)
# ============================================================
Log "Creating GitHub repository '$REPO_NAME'..."

gh repo create "$GITHUB_USERNAME/$REPO_NAME" `
    --public `
    --description "Finance Tracker — deployed to Azure Static Web Apps" 2>/dev/null

# Init git in the project folder and push to dev first
$PROJECT_DIR = $PSScriptRoot

Push-Location $PROJECT_DIR
git init -b main 2>/dev/null
git remote remove origin 2>/dev/null
git remote add origin "https://github.com/$GITHUB_USERNAME/$REPO_NAME.git"

Log "Pushing initial code to 'dev' branch..."
git add .
git commit -m "Initial commit — Finance Tracker static web app"

git checkout -b dev
git push -u origin dev
if ($LASTEXITCODE -ne 0) { Err "Failed to push to dev branch." }
Write-Host "  Pushed to dev branch." -ForegroundColor Green

Log "Merging dev into main and pushing to main..."
git checkout main
git merge dev --no-ff -m "Merge dev into main — initial release"
git push -u origin main
if ($LASTEXITCODE -ne 0) { Err "Failed to push to main branch." }
Write-Host "  Pushed to main branch." -ForegroundColor Green

# Protect main branch (require PR reviews)
gh api "repos/$GITHUB_USERNAME/$REPO_NAME/branches/main/protection" `
    --method PUT `
    --field required_status_checks='{"strict":true,"contexts":["Build and Deploy"]}' `
    --field enforce_admins=false `
    --field required_pull_request_reviews='{"required_approving_review_count":1}' `
    --field restrictions='null' 2>/dev/null
Write-Host "  Branch protection set on main." -ForegroundColor Green

Pop-Location

# ============================================================
# STEP 4 — Create Azure Resources
# ============================================================
Log "Creating Resource Group '$RESOURCE_GROUP' in '$AZURE_LOCATION'..."
az group create `
    --name $RESOURCE_GROUP `
    --location $AZURE_LOCATION `
    --output none
Write-Host "  Resource group created." -ForegroundColor Green

Log "Creating Azure Static Web App '$APP_NAME'..."
$SWA_JSON = az staticwebapp create `
    --name $APP_NAME `
    --resource-group $RESOURCE_GROUP `
    --source "https://github.com/$GITHUB_USERNAME/$REPO_NAME" `
    --location $AZURE_LOCATION `
    --branch main `
    --app-location "/" `
    --output-location "/" `
    --login-with-github `
    --sku Free `
    --output json

if ($LASTEXITCODE -ne 0) { Err "Failed to create Static Web App." }

$SWA = $SWA_JSON | ConvertFrom-Json
$DEPLOY_URL  = $SWA.defaultHostname
$DEPLOY_TOKEN = az staticwebapp secrets list `
    --name $APP_NAME `
    --resource-group $RESOURCE_GROUP `
    --query "properties.apiKey" -o tsv

Write-Host "  Static Web App created." -ForegroundColor Green
Write-Host "  URL: https://$DEPLOY_URL" -ForegroundColor Yellow

# ============================================================
# STEP 5 — Add deployment token as GitHub secret
# ============================================================
Log "Adding AZURE_STATIC_WEB_APPS_API_TOKEN to GitHub secrets..."
Push-Location $PSScriptRoot
$DEPLOY_TOKEN | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN
if ($LASTEXITCODE -ne 0) { Err "Failed to set GitHub secret." }
Write-Host "  Secret set." -ForegroundColor Green
Pop-Location

# ============================================================
# STEP 6 — Trigger first deployment
# ============================================================
Log "Triggering initial CI/CD run on main branch..."
gh workflow run azure-deploy.yml --repo "$GITHUB_USERNAME/$REPO_NAME" --ref main 2>/dev/null
Start-Sleep -Seconds 3
gh run list --repo "$GITHUB_USERNAME/$REPO_NAME" --limit 3

# ============================================================
# Done
# ============================================================
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " Deployment Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host " App URL    : https://$DEPLOY_URL"
Write-Host " GitHub Repo: https://github.com/$GITHUB_USERNAME/$REPO_NAME"
Write-Host " Azure RG   : $RESOURCE_GROUP"
Write-Host " App Name   : $APP_NAME"
Write-Host ""
Write-Host " CI/CD      : Every push to 'dev' or 'main' auto-deploys."
Write-Host " Next step  : Edit index.html, push to dev, open a PR to main."
Write-Host "========================================" -ForegroundColor Green
