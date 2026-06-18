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

## Verificação da distância nos cards do feed (2026-06-18)

Recurso: exibir "X km de você" nos cards de obras e reparos, calculado no cliente
(`distanciaKm`/`formatarDistancia` em `FeedObrasScreen.js` e `FeedReparosScreen.js`)
a partir das coordenadas retornadas pela API.

**Veredito: BLOCKED** para o pixel renderizado — não há device/emulador/Expo neste host
para dirigir a tela. O que *alimenta* a exibição foi confirmado contra a API de produção:

- ✅ **Dados presentes ao vivo.** `GET /obras` e `GET /reparos` retornam `latitude`/`longitude`
  (obras agora expõem após a correção do SELECT; reparos já expunham via `r.*`).
- ✅ **Fórmula/gating corretos.** Rodando a fórmula exata dos cards sobre linhas reais a
  partir de Patos de Minas:
  - obras geocodificadas em Patos → "menos de 1 km" / "1 km de você";
  - reparo de Ituiutaba (coords reais) → "316 km de você" (bate com os 316 km medidos na
    verificação do filtro de raio);
  - itens sem coordenadas → **sem** segmento de distância (gating `latitude != null`).
- ✅ **Limites da formatação.** Mesmo ponto e < 1 km → "menos de 1 km"; demais →
  arredondado "N km de você".

**Não verificado (pendente de device):** os pixels em si — layout do `Text` inline colorido
(`cardDistancia`), quebra/overflow, aparição real na tela e o comportamento com permissão de
localização negada. Para fechar: abrir o feed em/perto de Patos de Minas com localização
concedida e confirmar a distância nas obras/reparos geocodificados; alternar o filtro +500 km
e confirmar que a distância atualiza a partir do GPS.

Observação: na base de produção atual, a maioria dos itens não tem coordenadas, então
exibirão o card **sem** distância — comportamento correto, não um bug.

### Extensão: distância nas telas de detalhe

A mesma distância foi adicionada às telas de detalhe (`DetalheObraScreen.js` e
`DetalheReparoScreen.js`), na linha de local, com os mesmos helpers
(`distanciaKm`/`formatarDistancia`) e o mesmo carregamento de localização sem nova
permissão. As coordenadas sobrevivem ao `buscar()` da tela porque os endpoints de detalhe
retornam lat/lng: `GET /obras/:id` (`SELECT o.*`) e `GET /reparos/:id` (`SELECT *`).

**Verificação (2026-06-18) — veredito: BLOCKED** para o pixel renderizado (sem
device/emulador/Expo neste host). Risco específico das telas de detalhe — `buscar()`
sobrescreve o objeto vindo por params com a resposta do endpoint, então a distância só
persiste se o detalhe retornar coords — **descartado** ao vivo:

- ✅ `GET /obras/:id` (obra geocodificada `22262085`) → HTTP 200; resposta inclui
  `latitude`/`longitude` não-nulos → linha renderizada: "📍 Patos de Minas, Centro · 1 km de você".
- ✅ `GET /reparos/:id` (reparo de Ituiutaba `8c0effc8`) → HTTP 200; coords presentes →
  "📍 Ituiutaba, Cidade Jardim · 316 km de você" (bate com os 316 km do filtro de raio).
- ✅ Sem permissão de localização (`coords=null`) → segmento de distância omitido
  (gating `latitude != null`).
- ❌ Pixels não observados: `Text` inline colorido (`localDistancia`), layout/quebra e
  aparição real na tela.

Observação: os endpoints de detalhe incrementam `total_visitas` na leitura — efeito
esperado do app, não da mudança. Para fechar (PASS): abrir o detalhe de uma obra/reparo
geocodificado com localização concedida e confirmar a distância na linha de local.
