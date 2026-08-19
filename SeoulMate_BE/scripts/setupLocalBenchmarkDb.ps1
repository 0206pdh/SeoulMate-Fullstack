$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $projectRoot "docker-compose.benchmark.yml"
$migrationDirectory = Join-Path $projectRoot "db\migrations"

docker compose -f $composeFile up -d benchmark-db

for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  $health = docker inspect --format "{{.State.Health.Status}}" seoulmate-benchmark-db 2>$null
  if ($health -eq "healthy") {
    break
  }
  Start-Sleep -Seconds 1
}

if ($health -ne "healthy") {
  throw "Benchmark PostgreSQL did not become healthy."
}

$migrationFiles = Get-ChildItem -LiteralPath $migrationDirectory -Filter "*.sql" | Sort-Object Name
foreach ($migration in $migrationFiles) {
  Write-Host "Applying $($migration.Name)"
  $containerMigrationPath = "/tmp/$($migration.Name)"
  docker cp $migration.FullName "seoulmate-benchmark-db:$containerMigrationPath"
  if ($LASTEXITCODE -ne 0) {
    throw "Migration copy failed: $($migration.Name)"
  }
  docker exec seoulmate-benchmark-db psql -v ON_ERROR_STOP=1 -U seoulmate -d seoulmate_benchmark -f $containerMigrationPath
  if ($LASTEXITCODE -ne 0) {
    throw "Migration failed: $($migration.Name)"
  }
}

Write-Host "Local benchmark database is ready on 127.0.0.1:15433."
