# Leitura do banco de produção por túnel privado (sem "Public Access")

O Postgres da Railway fica SEM porta pública. O acesso é por um túnel SSH que a CLI da Railway
abre só enquanto o comando estiver rodando. Nada é alterado na Railway.

**Nunca** clicar em "Add Public Access" / "Public Networking" no serviço Postgres.

## Uma vez só (por máquina)

Feito nesta máquina em 16/11/2026 (CLI 5.74.0, login, link, chave SSH). Para repetir em outra:

```powershell
# `railway` instalado pelo npm precisa do node no PATH desta janela:
$env:Path = "C:\Users\Luiz Melo\AppData\Local\nvm\v24.15.0;$env:Path"
npm i -g @railway/cli
railway login                # abre o navegador → clicar em "Authorize"
cd "C:\Users\Luiz Melo\Downloads\pinturapro-api"
railway link -p determined-light -e production -s Postgres
railway status               # confere: determined-light / production / Postgres
# O túnel é SSH: precisa de uma chave local registrada na CONTA Railway (não mexe no projeto).
ssh-keygen -t ed25519        # só se não existir C:\Users\Luiz Melo\.ssh\id_ed25519
railway ssh keys add -n "tunel-leitura-<maquina>"
railway ssh keys list        # remover depois: railway ssh keys remove
```

## Toda vez que for consultar

**Janela 1 — o túnel (deixar aberta; Ctrl+C fecha o túnel):**

```powershell
railway connect Postgres --tunnel-only -P 15432
```

Ponta local: host `127.0.0.1`, porta `15432`, banco/usuário/senha os do serviço
(`PGDATABASE`, `PGUSER`, `PGPASSWORD`). URL:
`postgresql://<PGUSER>:<PGPASSWORD>@127.0.0.1:15432/<PGDATABASE>` — sem SSL (o túnel já cifra).

**Janela 2 — os scripts (somente leitura).** `railway run` injeta o `DATABASE_URL` do serviço
no processo, sem a senha aparecer na tela; como o host é o privado (`*.railway.internal`),
`scripts/db-leitura.js` troca por `127.0.0.1:15432` sozinho:

```powershell
cd "C:\Users\Luiz Melo\Downloads\pinturapro-api"
railway run -s Postgres node scripts/rodar-sql-leitura.js scripts/sql/auditoria-1h-15nov-e-saidas-3dias.sql
railway run -s Postgres node scripts/diagnostico-servico-dono.js "<nome do dono>" <categoria> [AAAA-MM-DD]
```

Alternativa sem `railway run` (a senha fica só na sessão do PowerShell):

```powershell
$env:DATABASE_URL = "postgresql://<PGUSER>:<PGPASSWORD>@127.0.0.1:15432/<PGDATABASE>"
node scripts/rodar-sql-leitura.js scripts/sql/<arquivo>.sql
```

## Garantias de leitura

- `scripts/db-leitura.js` abre toda sessão com `default_transaction_read_only = on`.
- `scripts/rodar-sql-leitura.js` recusa arquivo que não seja só `SELECT`/`WITH` e roda cada
  consulta em `BEGIN TRANSACTION READ ONLY … ROLLBACK`.
- Outra porta local: `-P <porta>` no túnel e `DB_TUNNEL_PORT=<porta>` nos scripts.
- `node` fora do PATH nesta máquina: usar `C:\Users\Luiz Melo\AppData\Local\nvm\v24.15.0\node.exe`.
