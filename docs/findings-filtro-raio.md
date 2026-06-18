# Achados da verificação — filtro de raio (feed)

Contexto: verificação do filtro de raio cumulativo (`(haversine <= raio) OR o.cidade = userCity`)
e do pré-filtro por bounding box, executada contra a API de produção em 2026-06-18.
Resultado geral: **PASS** (obras e reparos, conferência cruzada contra haversine independente).

## Achado: `obras.listar` não retorna `latitude`/`longitude` no SELECT — RESOLVIDO

> **Status: resolvido.** `o.latitude, o.longitude` foram adicionados ao SELECT de
> `listar`, alinhando com `/reparos`. O texto abaixo descreve o estado anterior.

`src/controllers/obrasController.js` (`listar`) selecionava colunas explícitas e **omitia
`latitude` e `longitude`**:

```sql
SELECT o.id, o.titulo, o.categoria, o.valor, o.cidade, o.estado, o.bairro, o.uf,
       o.metragem, o.prazo_execucao_dias, o.expira_em, o.tags, o.status,
       0 as distancia_metros, ...
FROM obras o
```

Em contraste, `GET /reparos` (`src/routes/index.js`) usa `SELECT r.*`, que **inclui**
`latitude`/`longitude`.

### Consequências
- O cliente nunca recebe as coordenadas das obras, então **a UI não consegue exibir a
  distância** de cada obra (o campo retornado é `distancia_metros = 0`, fixo).
- Dificulta a verificação/depuração do filtro de raio pelo lado do cliente: não dá para
  recomputar a distância de forma independente a partir da resposta de `/obras`
  (foi possível em `/reparos` justamente porque ele expõe as coordenadas).

### Observação importante
Isto **não** é causado pela correção do filtro de raio nem afeta a corretude do filtro —
o cálculo do haversine acontece no banco, sobre as colunas reais. É uma inconsistência
pré-existente entre os endpoints de obras e reparos.

### Resolução
`o.latitude, o.longitude` foram incluídos na lista de colunas do SELECT de `listar`,
padronizando com `/reparos` e permitindo que a UI exiba distância quando necessário.

## Limitação da verificação (registro)
Os dados de produção de obras eram homogêneos (todas em uma cidade, apenas 3 com
coordenadas), então o crescimento **por distância** não pôde ser observado no lado de
obras. Isso foi coberto por:
- o limite de fronteira em `/reparos` (reparo de Ituiutaba a 316 km entra em +500 km e
  não em +300 km), e
- o teste numérico offline do bounding box (9.000 pontos de fronteira, 0 falsos negativos).
