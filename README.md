# Agenda+

## Perfis de acesso

- **Cliente:** cria uma conta com nome, e-mail, telefone e senha; acompanha a vitrine, favoritos, lojas visitadas e atendimentos.
- **Funcionário:** cria uma conta sem precisar do código da loja. Depois de entrar, vincula uma ou mais lojas pelo código na seção **Meu Perfil**.
- **Dono:** cria e administra o estabelecimento e gera o código de acesso da equipe no painel.

Na seção **Perfil & Equipe**, o dono pode definir o percentual de cada atendimento que fica para a empresa, individualmente por funcionário. O percentual inicial é 0% até que seja configurado.

Os serviços cadastrados em **Atividades** são salvos no estabelecimento e publicados na vitrine e na tela de agendamento. O dono pode atribuir cada serviço a si mesmo e aos funcionários vinculados; o cliente escolhe entre os profissionais associados ao serviço, e o agendamento mantém essa atribuição.

As vitrines públicas podem ser acessadas pelo endereço exclusivo da loja sem login. Para escolher um serviço e iniciar o agendamento, o cliente entra na conta; após o login, o serviço escolhido é mantido. A tela de agendamento e a área do cliente oferecem navegação de volta para a loja. O proprietário configura o expediente semanal no painel; os horários ao público usam somente esses períodos e dias sem configuração não recebem horários por padrão.

Bloqueios definidos pelo proprietário valem para a agenda da loja e são exibidos aos profissionais vinculados. Bloqueios pessoais de um profissional e seus atendimentos reservados são compartilhados entre todas as lojas a que ele está vinculado. A agenda do profissional permite alternar entre uma loja e a visão de todas as lojas.

O proprietário pode cadastrar uma chave PIX no perfil da loja. Quando configurada, ela aparece no agendamento como opção de pagamento; a reserva é registrada como pendente e o pagamento precisa ser confirmado pela loja. A agenda do proprietário carrega os agendamentos persistidos, com valor, forma de pagamento e filtros por data, profissional e horário.

As sessões são independentes por navegador/dispositivo. A opção **Manter conectado neste dispositivo** cria uma sessão persistente; sair invalida somente a sessão atual.

## Cobrança

Configure no ambiente do backend as variáveis do Mercado Pago e `APP_BASE_URL`, conforme `backend/.env.example`. O backend suspende o acesso após o vencimento e cancela a assinatura recorrente quando o Mercado Pago confirma o cancelamento.

## Vitrine pública

O dono configura o endereço exclusivo da loja e os links de Instagram, Facebook, TikTok e YouTube na aba **Vitrine** do painel. Depois de salvar, a página pode ser acessada em `https://<domínio>/<endereço-da-loja>`; os links antigos por ID continuam funcionando. As colunas e o índice necessários são adicionados automaticamente pelo backend sem apagar os dados existentes. Publique as alterações do frontend e do backend para ativar a funcionalidade.

## Testes

Execute `npm --prefix backend test` na raiz do repositório.
