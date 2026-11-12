# Agenda+

## Perfis de acesso

- **Cliente:** cria uma conta com nome, e-mail, telefone e senha; acompanha a vitrine, favoritos, lojas visitadas e atendimentos.
- **Funcionário:** cria uma conta sem precisar do código da loja. Depois de entrar, vincula uma ou mais lojas pelo código na seção **Meu Perfil**.
- **Dono:** cria e administra o estabelecimento e gera o código de acesso da equipe no painel.

Na seção **Perfil & Equipe**, o dono pode definir o percentual de cada atendimento que fica para a empresa, individualmente por funcionário. O percentual inicial é 0% até que seja configurado.

Os serviços cadastrados em **Atividades** são salvos no estabelecimento e publicados na vitrine e na tela de agendamento. O dono pode atribuir cada serviço a si mesmo e aos funcionários vinculados.

As vitrines públicas podem ser acessadas pelo endereço exclusivo da loja sem login. Para escolher um serviço e iniciar o agendamento, o cliente entra na conta; após o login, o serviço escolhido é mantido. A tela de agendamento e a área do cliente oferecem navegação de volta para a loja.

As sessões são independentes por navegador/dispositivo. A opção **Manter conectado neste dispositivo** cria uma sessão persistente; sair invalida somente a sessão atual.

## Cobrança

Configure no ambiente do backend as variáveis do Mercado Pago e `APP_BASE_URL`, conforme `backend/.env.example`. O backend suspende o acesso após o vencimento e cancela a assinatura recorrente quando o Mercado Pago confirma o cancelamento.

## Vitrine pública

O dono configura o endereço exclusivo da loja e os links de Instagram, Facebook, TikTok e YouTube na aba **Vitrine** do painel. Depois de salvar, a página pode ser acessada em `https://<domínio>/<endereço-da-loja>`; os links antigos por ID continuam funcionando. As colunas e o índice necessários são adicionados automaticamente pelo backend sem apagar os dados existentes. Publique as alterações do frontend e do backend para ativar a funcionalidade.

## Testes

Execute `npm --prefix backend test` na raiz do repositório.
