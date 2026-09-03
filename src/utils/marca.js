// Marca ÚNICA da plataforma, exibida em tudo que uma pessoa lê: pushes, e-mails, contrato
// em PDF, checkout dos gateways e o rótulo do 2FA.
//
// Antes havia DUAS marcas e uma regra que escolhia entre elas pelo tipo de usuário
// ("PinturaPro - ArrumaPro" para reparo, "PinturaPro" para pintura). A regra acabou: tudo é
// ProTudo. MARCA_REPARO e MARCA_PINTURA continuam exportados apontando para a mesma string,
// para não quebrar nenhum import — código novo deve usar MARCA.
const MARCA = 'ProTudo'

// Site institucional exibido em copy (hoje, o rodapé do contrato em PDF). Fica aqui junto da
// marca para os dois nunca divergirem. NÃO é host de infraestrutura: os endereços do Railway
// são reais e continuam onde estão.
const SITE = 'www.protudo.app.br'

// Aliases da regra antiga. Idênticos a MARCA de propósito: nada mais varia por tipo.
const MARCA_REPARO  = MARCA
const MARCA_PINTURA = MARCA

// Shim da regra antiga: ignora o usuário e devolve sempre a marca única. Mantido para os
// chamadores que ainda passam a linha de usuarios; não há mais o que decidir aqui.
const marcaPorTipo = () => MARCA

module.exports = { MARCA, SITE, MARCA_REPARO, MARCA_PINTURA, marcaPorTipo }
