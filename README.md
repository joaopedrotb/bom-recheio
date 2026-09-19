# Bom Recheio 🧡 · Salgaderia

Caderno digital de vendas e despesas da salgaderia **Bom Recheio**. Registre vendas por pacote (50 ou 100 unidades) e despesas em categorias, e acompanhe o saldo do dia, da semana ou do mês — tudo compartilhado entre as pessoas do negócio (até 3 usuários).

## Funcionalidades

- 🔐 Cadastro de até **3 usuários** no mesmo negócio (sessão persistente de 365 dias)
- ➕ **Novas vendas**: pacote 50/100, quantidade, valor, cliente e forma de pagamento (dinheiro / PIX / cartão)
- ➖ **Novas despesas**: ingredientes, gás, embalagem, transporte ou outros
- 📊 **Saldo por período**: hoje · semana · mês, com total de unidades vendidas e lista de lançamentos (mais recentes primeiro)
- 🗑️ Exclusão de lançamentos com confirmação
- 📱 Responsivo (celular, tablet e desktop) com paleta quente creme/marrom/dourado
- 🔒 Senhas com hash (bcryptjs), tokens JWT, prepared statements (anti SQL injection), rate-limit em login/cadastro e headers de segurança

## Stack

| Camada     | Tecnologia                                            |
|------------|-------------------------------------------------------|
| Backend    | Node.js 24 + Express 4                                |
| Banco      | SQLite (módulo nativo `node:sqlite`)                  |
| Frontend   | HTML + CSS + JavaScript vanilla (SPA, sem frameworks) |
| Deploy     | Cloudflare Workers + D1                               |

## Como rodar localmente

Pré-requisito: **Node.js 24+** (o app usa o módulo nativo `node:sqlite`).

```bash
npm install
npm start
```

Abra `http://localhost:3000`. O banco `bom-recheio.db` é criado automaticamente na primeira execução; basta criar a primeira conta.

> O segredo do JWT fica em `.secret.key` (gerado automaticamente) — **não** versionar nem expor por HTTP. Usuários, banco e segredo são ignorados pelo `.gitignore`.

## Estrutura

```
server.js       API Express + SQLite (schema, auth, validações, rate-limit)
public/
  index.html    SPA (tela de autenticação + aplicativo)
  styles.css    tema quente e acessibilidade (contraste AA, :focus-visible)
  app.js        lógica da interface (fetch, render seguro, ARIA)
test/           testes de regressão da API
```

## API

| Método  | Rota                     | Descrição                                        |
|---------|--------------------------|--------------------------------------------------|
| POST    | `/api/register`          | Criar conta (máx. 3 usuários)                    |
| POST    | `/api/login`             | Entrar e receber token                           |
| GET     | `/api/me`                | Usuário da sessão                                |
| POST    | `/api/sales`             | Registrar venda                                  |
| POST    | `/api/expenses`          | Registrar despesa                                |
| DELETE  | `/api/sales/:id`         | Excluir venda                                    |
| DELETE  | `/api/expenses/:id`      | Excluir despesa                                  |
| GET     | `/api/transactions?period=day\|week\|month` | Totais + lançamentos |

Autenticação via `Authorization: Bearer <token>` (exceto register e login).

## Testes de regressão

Com o servidor rodando em `http://localhost:3000`:

```bash
node test/regression.js
```

Cobre validações de quantidade/valor, e-mail, rate-limit, tratamento de erros 413/400, exclusão de lançamentos e headers de segurança. Resultado da auditoria original: **22 casos executados, 0 falhas** após as correções.

## Implantação (Cloudflare Workers + D1)
*(em preparação — os arquivos `wrangler.jsonc`, `src/` e `data/schema.sql` são adicionados junto com o deploy)*

O deploy usa **Cloudflare Workers + D1** (o SQLite gerenciado do Cloudflare), garantindo dados **persistentes** na nuvem.

## Licença

Uso interno do negócio Bom Recheio.