# Agenda+

## Perfis de acesso

- **Cliente:** cria uma conta com nome, e-mail, telefone e senha; acompanha a vitrine, favoritos, lojas visitadas e atendimentos.
- **Funcionário:** cria uma conta e informa o código gerado pelo dono da loja. Uma conta pode se vincular a várias lojas.
- **Dono:** cria e administra o estabelecimento e gera o código de acesso da equipe no painel.

As sessões são independentes por navegador/dispositivo. A opção **Manter conectado neste dispositivo** cria uma sessão persistente; sair invalida somente a sessão atual.

## Cobrança

Configure no ambiente do backend as variáveis do Mercado Pago e `APP_BASE_URL`, conforme `backend/.env.example`. O backend suspende o acesso após o vencimento e cancela a assinatura recorrente quando o Mercado Pago confirma o cancelamento.

## Vitrine pública

O dono configura o endereço exclusivo da loja e os links de Instagram, Facebook, TikTok e YouTube na aba **Vitrine** do painel. Depois de salvar, a página pode ser acessada em `https://<domínio>/<endereço-da-loja>`; os links antigos por ID continuam funcionando. As colunas e o índice necessários são adicionados automaticamente pelo backend sem apagar os dados existentes. Publique as alterações do frontend e do backend para ativar a funcionalidade.

## Testes

Execute `npm --prefix backend test` na raiz do repositório.
