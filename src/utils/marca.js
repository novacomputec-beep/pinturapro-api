// Marca exibida em e-mails conforme o tipo de usuário / fluxo:
//   - reparos  (tipo_prestador 'reparador' ou tipo_dono 'reparo')  → "PinturaPro - ArrumaPro"
//   - pintura  (pintor/construtor / dono_obra e demais)            → "PinturaPro"
const MARCA_REPARO  = 'PinturaPro - ArrumaPro'
const MARCA_PINTURA = 'PinturaPro'

const marcaPorTipo = ({ tipo_prestador, tipo_dono } = {}) =>
  (tipo_prestador === 'reparador' || tipo_dono === 'reparo') ? MARCA_REPARO : MARCA_PINTURA

module.exports = { MARCA_REPARO, MARCA_PINTURA, marcaPorTipo }
