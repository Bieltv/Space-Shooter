# Neon Void

Jogo estático de tiro vertical em HTML, CSS, JavaScript e JSON. A interface funciona no navegador; autenticação, contas compartilhadas e ranking usam Firebase por meio de um Cloudflare Worker.

## Executar

Abra `index.html` em um servidor estático, como a extensão Live Server do VS Code, ou publique a raiz do projeto no GitHub Pages. O jogo carrega os catálogos JSON por `fetch`, então não deve ser aberto usando o protocolo `file://`.

## Organização

- `index.html`: telas de conta, menu, configurações, skins, loja, missões, partida e diálogos.
- `css/style.css`: identidade visual neon e layout adaptável para desktop e mobile.
- `js/app.js`: interface, controles, jogo, persistência local e integração com a API de contas.
- `worker/index.js`: API Cloudflare Worker para Firebase Authentication, perfis, sincronização de conta e ranking.
- `worker/wrangler.toml`: projeto Firebase, origens CORS e configuração do Wrangler.
- `worker/package.json` e `worker/package-lock.json`: dependências e comandos locais/publicação do Worker.
- `worker/.dev.vars.example`: modelo local para secrets do Worker; copie para `worker/.dev.vars` e preencha sem versionar.
- `js/config.js`: URL pública do Worker. Não coloque senhas, chaves privadas ou outros secrets neste arquivo.
- `SITES/`: páginas estáticas embutidas no jogo para solicitar acesso ADM e administrar solicitações na conta mestre.
- `firestore.indexes.json`: índice Firestore usado pelo ranking compartilhado.
- `data/missions.json`: conjuntos de missões em português brasileiro e inglês.
- `data/skins.json`: catálogo visual, raridades e futuras skins de eventos.
- `data/events.json`: eventos ativos, agendados e futuros exibidos na tela de Eventos, incluindo fases e metas.
- `data/battle-pass.json`: níveis, fichas, recompensas e custos de evolução do Passe do Néon.
- `data/badges.json`: catálogo traduzido de emblemas, raridades e descrições.
- `data/promo-codes.json`: códigos promocionais, prazos opcionais e recompensas.
- `data/store.json`: Pacote Inicial, Luck Drops, Caixa Especial, chances/recompensas e pacotes de diamantes.
- `manifest.webmanifest`, `sw.js` e `icons/`: instalação PWA, suporte offline e ícones do aplicativo.

## Contas e dados

- Novas contas usam e-mail/senha no Firebase Authentication e armazenam seus dados de jogo no Firestore via Worker. Uma cópia local permite continuar no aparelho; a sessão é renovada automaticamente quando há conexão.
- Contas antigas continuam disponíveis pelo nome de jogador e senha locais. Entre na conta antiga e use **Migrar conta local** nas Configurações para transferir os dados para o Firebase; progresso de missões também é migrado.
- Ao abrir esta versão pela primeira vez, cada conta local sem migração recebe prazo de 3 dias. Se não for migrada, seus dados locais e o progresso separado de missões são removidos ao fim do prazo. Exporte um backup antes de continuar se quiser preservar uma cópia.
- Configurações permanecem locais. A autenticação do Firebase permite recuperação de senha pelas ferramentas do Firebase, mas o jogo ainda não inclui fluxo próprio de redefinição.
- Em Configurações, exporte a conta para um JSON criptografado com AES-GCM/PBKDF2. A senha não é gravada no arquivo; a mesma senha é necessária para importar. Proteja o arquivo e guarde a senha: não há recuperação se perder ambos.
- Esses dados podem ser apagados ao limpar o armazenamento do navegador e podem ser inspecionados ou alterados por quem tem acesso ao navegador. Não use senhas reais neste protótipo.
- **Excluir conta e dados** exige confirmação de senha e remove permanentemente a conta Firebase, o perfil público, dados sincronizados, a cópia local e o progresso de missões. Configurações gerais permanecem neste navegador.
- A participação no ranking compartilhado é opcional. O ranking mostra o nome público, recorde e emblemas; o filtro por estado usa apenas a região compartilhada pelo jogador.
- O novo modo ADM é independente das Configurações e dos painéis administrativos antigos. Para ativá-lo, a conta conectada resgata o código ADM na Caixa de entrada e reinicia o jogo. O Worker valida o código pelo secret `ADM_ACTIVATION_CODE` (mínimo de 24 caracteres), concede o emblema `admin-account` e registra o acesso no perfil; não coloque esse código em `data/promo-codes.json`. Em produção, configure-o com `npx wrangler secret put ADM_ACTIVATION_CODE` dentro de `worker/`; no desenvolvimento, use `worker/.dev.vars`. A conta ADM tem Neon-moedas e diamantes infinitos e um nome RGB com selo dourado. Pode presentear até 10 Passes Neon Ouro no total e, por presente, até 10.000 Neon-moedas ou 1.000 diamantes. A autorização e os limites são conferidos pelo Worker. Os antigos fluxos de solicitação e painel mestre permanecem no Worker para compatibilidade, mas não aparecem nas Configurações e não concedem este novo modo.
- Em Configurações, contas conectadas podem alterar o nome uma vez a cada 30 dias; a disponibilidade é validada pelo Worker junto com a reserva exclusiva do nome.
- Contas conectadas podem enviar e aceitar/recusar pedidos de amizade por ID ou nome. Amigos podem ver skins e status do Passe; saldos permanecem privados. Presentear o Passe Neon Ouro custa 600 diamantes para contas comuns; o modo ADM pode presentear até 10 Passes no total. Moedas e diamantes também podem ser presenteados a amigos, com limites de 10.000 Neon-moedas e 1.000 diamantes por presente para ADM.
- A loja tem a Caixa Especial de 8 a 24 de dezembro de 2026: 1.000 diamantes por giro ou 10.000 por dez giros. Cada skin especial tem 3,1% de chance; as recompensas de moedas configuradas totalizam 87,6%. Repetições de skin são convertidas em 100 moedas.
- A loja não aceita pagamentos reais. O Pacote Inicial e Luck Drops usam Neon-moedas; diamantes usam Money-Void, uma moeda virtual obtida no minigame de precisão. Novas contas recebem a oferta do pacote inicial por 45 dias.
- Um Luck Drop custa 1.000 Neon-moedas. Ao abrir, confirme o custo e pressione **Girar** para iniciar a roleta animada. As chances são: Comum 58,6%, Incomum 25%, Raro 10%, Épico 5% e Lendário 1,4%. Ele concede uma skin ainda bloqueada da raridade sorteada ou moedas como compensação; skins não são duplicadas e skins de passe/evento, além das três do Pacote Inicial, ficam fora do catálogo da loja. As Luck Drops do Passe usam apenas a lista exclusiva configurada para elas. Vazio Neon é uma skin lendária exclusiva para nave.
- A tela de diamantes troca Money-Void por pacotes de 100, 500, 1.000, 2.500 ou 4.500 diamantes e vende a nave Rosa Neon (750), o Escudo Grafite (450) e o tiro LED (500). O saldo Money-Void aparece apenas na loja de diamantes e nas telas de Eventos.
- O Passe do Néon tem 30 níveis, trilhas Prata (grátis) e Ouro (450 diamantes virtuais). Uma ficha aparece a cada 15 segundos de partida e precisa ser coletada; os níveis 1–7 exigem 5 fichas, 8–16 exigem 10, 17–26 exigem 20 e 27–30 exigem 25. O progresso e as recompensas são salvos na conta e sincronizados quando conectada.
- Cada trilha entrega 10 Luck Drops exclusivos, cinco cargas de habilidade e 1.500 Neon-moedas; a trilha grátis também entrega três skins de nave e duas de escudo. Os Luck Drops do passe têm um catálogo separado, incluindo uma nave lendária branca neon e um escudo épico dourado pulsante; duplicatas viram 500 Neon-moedas.
- Novas contas recebem uma carga de cada habilidade inicial. Escolha e confirme tiro triplo por 30 segundos, escudo invulnerável por 45 segundos ou duas vidas extras por 120 segundos; cada habilidade consome sua própria carga. Cargas genéricas recebidas no Passe podem ser usadas em qualquer habilidade. Sem cargas de nenhuma habilidade, a partida começa diretamente.
- A trilha Ouro concede o tiro Bengala Doce no nível 1, o escudo Pisca-Pisca no nível 15 e a nave Árvore de Natal no nível 30. Em Skins, configure o Pisca-Pisca (desligado, piscando rápido/devagar ou ligado) e visualize o resultado. Evolua a árvore do estágio 1 para 2 por 450 diamantes e do estágio 2 para 3 por 700 diamantes.
- Emblemas hexagonais registram a data de conquista na conta. No Perfil, contas conectadas podem equipar até três emblemas; o servidor confere no Firestore se cada um foi conquistado antes de salvar. A versão do jogo é exibida em Configurações.
- A cada 6 horas, o minigame de precisão permite uma tentativa: clique quando o alvo móvel passar pelo retículo central para ganhar 100 Money-Void diretamente na carteira.
- A caixa de entrada mantém mensagens e recompensas resgatáveis por códigos promocionais. O exemplo `NEONSTART` concede 250 Neon-moedas e a skin Folha; edite `data/promo-codes.json` para configurar outros códigos, moedas, diamantes ou skins. Códigos resgatados são limitados a uma vez por conta.
- A tela de Eventos lê `data/events.json`; cada evento tem título, descrição e datas ISO para início e fim. Os atalhos circulares de Eventos e Caixa de entrada ficam abaixo do botão de Depuração.
- O botão de depuração fica oculto até resgatar `DEPURATIONMODE` na Caixa de entrada. O código é público no JSON; serve apenas para habilitar ferramentas de teste, não para controle de acesso seguro.
- O Passe do Néon fica oculto até 30 de novembro de 2026. O Desafio Neon Cinza começa nesse dia e termina em 25 de dezembro, com metas cumulativas de 150.000, 300.000 e 440.000 pontos. A partida usa inimigos e chefe normais, aceita habilidades iniciais e, na meta final da terceira etapa, libera três skins épicas cinza: nave, escudo e tiro.
- Para publicar no GitHub Pages, publique a raiz do projeto em HTTPS. O `manifest.webmanifest` e o service worker usam caminhos relativos, por isso funcionam tanto no domínio principal quanto em um repositório de projeto. O shell e os catálogos JSON são armazenados em cache para abertura offline; autenticação e ranking exigem conexão.
- Como o jogo é estático, códigos promocionais comuns ficam públicos nos JSON e a validação é local. O código do painel mestre é a exceção: validado pelo Worker e protegido também por senha mestre.

## Configuração da API Firebase

1. Crie o banco Firestore no projeto configurado. O provedor **E-mail/senha** é configurado em `firebase.json`.
2. Na pasta `worker`, execute `npm install`. Para desenvolvimento local, copie `.dev.vars.example` para `.dev.vars` e preencha as credenciais; `npm run dev` usa automaticamente esse arquivo porque ele fica ao lado de `wrangler.toml`. Para implantação, use `npx wrangler secret put` para configurar `FIREBASE_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `ACCOUNT_SPECIAL_CODE`, `MASTER_PASSWORD` e `ADM_ACTIVATION_CODE`. Use um código ADM aleatório com pelo menos 24 caracteres e compartilhe-o apenas com quem deve receber acesso. Para trocar a senha mestre, execute `npx wrangler secret put MASTER_PASSWORD` dentro de `worker` e informe a nova senha no prompt do Wrangler; não a cole no código ou no chat. Para desenvolvimento local, atualize os valores em `worker/.dev.vars` e reinicie o Worker. Nunca coloque credenciais no frontend ou no controle de versão.
3. Configure `FIREBASE_PROJECT_ID` e `ALLOWED_ORIGINS` em `worker/wrangler.toml`. Inclua a origem exata do site publicado e as origens locais de desenvolvimento. O painel mestre já está incluído no site em `SITES/master.html`; não é necessário criar outro GitHub Pages. Se hospedar uma cópia em outro domínio, adicione a origem exata a `ALLOWED_ORIGINS`.
4. Configure `window.NEON_VOID_CONFIG.apiBaseUrl` em `js/config.js` com a URL pública do Worker. Esse valor é público; o arquivo não deve conter secrets.
5. Publique autenticação/índices pela Firebase CLI: `firebase deploy --only auth,firestore:indexes --project space-shooter-14d6a`. Publique o Worker com `npm run deploy` executado na pasta `worker` (após configurar os secrets no Cloudflare). O Worker persiste solicitações e funções ADM no Firestore.

Os catálogos de skins, loja, moedas, eventos e missões permanecem nos JSON públicos porque o navegador estático precisa carregá-los; movê-los para `.env` não os tornaria secretos e o navegador não consegue ler esse arquivo com segurança. O Worker mantém no servidor somente secrets e decisões de autorização. O jogo não possui validação antitrapaça autoritativa para recordes ou saldos.

## Controles e testes

- Execute `node --test worker\index.test.mjs worker\features.test.mjs` para verificar as sessões administrativas e os fluxos/catálogos relacionados.
- Mover a nave: mouse ou toque dentro da área de jogo.
- Atirar: automático, a cada 500 ms. Pausar: Esc.
- Ative a habilidade das skins especiais pelo botão na tela ou pela tecla H. Chama: começa com uma vida a menos; após 190 s, custa quatro vidas e atinge até 100 inimigos ou causa 75% da vida máxima do chefe. Gelo: começa com quatro vidas a menos, adiciona três de dano e congela inimigos/chefe por 50 s após carregar por 120 s; requer evolução de vida acima de quatro. Círculo Negro: disponível após dois chefes, custa duas vidas, concede 40 s de invulnerabilidade e recarrega em 30 s. Explosiva: após 200 s, custa uma vida e atinge até 100 inimigos ou causa 50% da vida máxima do chefe; a quantidade de usos depende das vidas restantes, sem limite artificial por partida.
- Na pausa, abra Configurações e use **Voltar para a partida** para retomar depois.
- A partida tem três vidas, inimigos quadrados que valem 50 pontos e power-ups de escudo e tiro triplo.
- Em desktop, selecione **Tela cheia (PC)** nas configurações para iniciar a partida em tela cheia. Em telas pequenas, o jogo permanece em janela responsiva.
- A cada 100 pontos, a conta recebe 10 moedas ao encerrar a partida. Desistir pelo menu de pausa abandona a partida e descarta seu progresso sem conceder moedas.
- Evolua dano, vidas iniciais e capacidade do escudo na tela **Evolução**. Cada melhoria tem nível máximo 10, custa 100 moedas no primeiro nível e tem preços aleatórios nos seguintes.
- Um chefe hexagonal aparece após 60 segundos de partida. Depois de derrotá-lo, aguarde 60 segundos para o próximo. Ele dispara projéteis e é protegido por três quadrados com 10 de vida; elimine-os para causar dano ao chefe, que tem 150 de vida. Os tiros do jogador pausam durante a chegada do chefe.
- O Natal Neon aparece bloqueado sete dias antes de começar. De 1 a 25 de dezembro, quatro fases exibem metas cumulativas de pontuação; a fase 4 dura sete dias. O chefe natalino tem 100 de vida, não ataca e concede 5.000 pontos ao ser derrotado. O progresso fica salvo na conta e sincronizado quando conectada.
- As metas finais das fases 2, 3 e 4 liberam respectivamente uma skin de tiro de estrelas, um escudo de guirlanda e a skin épica evolutiva Bola de Natal. A cada 500 pontos após desbloqueá-la, ela evolui (vermelha, verde, dourada e prateada); cada evolução aumenta em 1% o dano da nave enquanto a skin estiver equipada.
- Abra a depuração pelo botão no topo ou F3. As ferramentas permitem executar verificações, testar power-ups, simular derrota, completar missões e ajustar a carteira local.
- O próximo ciclo de missões começa 12 horas após a conclusão de todas as missões. A interface usa a fonte Press Start 2P.
