import React, { useState, useEffect } from 'react'
import {
  View, Text, StyleSheet, SafeAreaView, FlatList,
  TouchableOpacity, RefreshControl, ActivityIndicator, Image
} from 'react-native'
import { obrasService } from '../../services/api'
import { useAuth } from '../../contexts/AuthContext'
import { cores, espacos, raios } from '../../utils/tema'

const CATEGORIAS = [
  { id: 'todas',       label: 'Todas'       },
  { id: 'residencial', label: 'Residencial' },
  { id: 'comercial',   label: 'Comercial'   },
  { id: 'galpoes',     label: 'Galpões'     },
  { id: 'outras',      label: 'Outras'      },
]

const formatarCountdown = (expiraEm) => {
  const diff = new Date(expiraEm) - new Date()
  if (diff <= 0) return null
  const horas = Math.floor(diff / 3600000)
  const minutos = Math.floor((diff % 3600000) / 60000)
  if (horas < 24) return `${horas}h ${minutos}m`
  return `${Math.floor(horas / 24)} dias`
}

const CardObra = ({ obra, onPress }) => {
  const countdown = formatarCountdown(obra.expira_em)
  const urgente = countdown && !countdown.includes('dia')

  return (
    <TouchableOpacity
      style={[estilos.card, urgente && estilos.cardUrgente]}
      onPress={() => onPress(obra)}
      activeOpacity={0.85}
    >
      <View style={estilos.cardImagem}>
        {obra.foto_capa ? (
          <Image
            source={{ uri: obra.foto_capa }}
            style={estilos.fotoImagem}
            resizeMode="cover"
          />
        ) : (
          <Text style={estilos.cardImagemIcone}>🏠</Text>
        )}
        {countdown && (
          <View style={[estilos.countdownPill, urgente && estilos.countdownUrgente]}>
            {urgente && <View style={estilos.countdownDot} />}
            <Text style={[estilos.countdownTexto, urgente && { color: cores.primaria }]}>
              {urgente ? `Expira ${countdown}` : `Expira em ${countdown}`}
            </Text>
          </View>
        )}
        {obra.total_midias > 0 && (
          <View style={estilos.midiasbadge}>
            <Text style={estilos.midiasTexto}>📷 {obra.total_midias}</Text>
          </View>
        )}
      </View>

      <View style={estilos.cardCorpo}>
        <View style={estilos.cardTopo}>
          <Text style={estilos.cardTitulo} numberOfLines={2}>{obra.titulo}</Text>
          <Text style={estilos.cardValor}>
            R$ {Number(obra.valor).toLocaleString('pt-BR')}
          </Text>
        </View>

        <Text style={estilos.cardLocalTexto}>
          {obra.cidade}, MG{obra.metragem ? ` · ${obra.metragem}m²` : ''}
        </Text>

        <View style={estilos.cardRodape}>
          <Text style={estilos.cardCategoria}>{obra.categoria}</Text>
          <TouchableOpacity style={estilos.btnVerObra} onPress={() => onPress(obra)}>
            <Text style={estilos.btnVerObraTexto}>Ver obra →</Text>
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  )
}

export default function FeedScreen({ navigation }) {
  const { usuario } = useAuth()
  const [obras, setObras] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [atualizando, setAtualizando] = useState(false)
  const [categoria, setCategoria] = useState('todas')
  const [erro, setErro] = useState(null)

  const buscarObras = async () => {
    try {
      setErro(null)
      const resposta = await obrasService.listar({ categoria })
      setObras(resposta.obras || [])
    } catch (err) {
      setErro(err.mensagem || 'Erro ao buscar obras')
    } finally {
      setCarregando(false)
      setAtualizando(false)
    }
  }

  useEffect(() => { buscarObras() }, [categoria])

  const onRefresh = () => {
    setAtualizando(true)
    buscarObras()
  }

  return (
    <SafeAreaView style={estilos.container}>
      <View style={estilos.header}>
        <View>
          <Text style={estilos.saudacao}>Olá, {usuario?.nome?.split(' ')[0]} 👷</Text>
          <Text style={estilos.titulo}>
            Obras <Text style={{ color: cores.primaria }}>disponíveis</Text>
          </Text>
        </View>
        <TouchableOpacity style={estilos.avatar} onPress={() => navigation.navigate('Perfil')}>
          <Text style={estilos.avatarTexto}>
            {usuario?.nome?.substring(0, 2).toUpperCase()}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={estilos.filtrosRow}>
        {CATEGORIAS.map((c) => (
          <TouchableOpacity
            key={c.id}
            style={[estilos.filtroPill, categoria === c.id && estilos.filtroPillAtivo]}
            onPress={() => setCategoria(c.id)}
          >
            <Text style={[estilos.filtroPillTexto, categoria === c.id && estilos.filtroPillTextoAtivo]}>
              {c.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={estilos.contadorTexto}>{obras.length} obras em aberto</Text>

      {erro && (
        <View style={estilos.erroBox}>
          <Text style={estilos.erroTexto}>{erro}</Text>
          <TouchableOpacity onPress={buscarObras}>
            <Text style={{ color: cores.primaria, marginTop: 8 }}>Tentar novamente</Text>
          </TouchableOpacity>
        </View>
      )}

      {carregando ? (
        <ActivityIndicator color={cores.primaria} size="large" style={{ flex: 1 }} />
      ) : obras.length === 0 && !erro ? (
        <View style={estilos.vazio}>
          <Text style={estilos.vazioIcone}>📋</Text>
          <Text style={estilos.vazioTitulo}>Nenhuma obra disponível</Text>
          <Text style={estilos.vazioSub}>Novas obras aparecerão aqui em breve.</Text>
        </View>
      ) : (
        <FlatList
          data={obras}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <CardObra
              obra={item}
              onPress={(obra) => navigation.navigate('DetalheObra', { obra })}
            />
          )}
          contentContainerStyle={estilos.lista}
          ItemSeparatorComponent={() => <View style={{ height: 14 }} />}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={atualizando} onRefresh={onRefresh} tintColor={cores.primaria} />
          }
        />
      )}
    </SafeAreaView>
  )
}

const estilos = StyleSheet.create({
  container: { flex: 1, backgroundColor: cores.fundo },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: espacos.tela, paddingTop: 8, paddingBottom: 14,
  },
  saudacao: { fontSize: 13, color: cores.textoFraco, marginBottom: 2 },
  titulo: { fontSize: 26, fontWeight: '700', color: cores.textoForte, letterSpacing: -0.5 },
  avatar: {
    width: 34, height: 34, backgroundColor: cores.primariaSuave,
    borderWidth: 0.5, borderColor: cores.primariaBorda,
    borderRadius: 17, alignItems: 'center', justifyContent: 'center',
  },
  avatarTexto: { color: cores.primaria, fontSize: 12, fontWeight: '700' },
  filtrosRow: {
    flexDirection: 'row', paddingHorizontal: espacos.tela,
    gap: 8, marginBottom: 12, flexWrap: 'wrap',
  },
  filtroPill: {
    backgroundColor: cores.fundoElevado, borderWidth: 0.5, borderColor: cores.borda,
    borderRadius: raios.pill, paddingHorizontal: 14, paddingVertical: 6,
  },
  filtroPillAtivo: { backgroundColor: cores.primaria, borderColor: cores.primaria },
  filtroPillTexto: { fontSize: 12, color: cores.textoMedio },
  filtroPillTextoAtivo: { color: '#0A0A0A', fontWeight: '600' },
  contadorTexto: { fontSize: 12, color: cores.textoFraco, paddingHorizontal: espacos.tela, marginBottom: 10 },
  lista: { paddingHorizontal: espacos.tela, paddingBottom: 32 },
  erroBox: { alignItems: 'center', padding: 20 },
  erroTexto: { color: cores.perigo, fontSize: 13, textAlign: 'center' },
  vazio: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  vazioIcone: { fontSize: 36, marginBottom: 16 },
  vazioTitulo: { fontSize: 16, fontWeight: '600', color: cores.textoFraco, marginBottom: 8 },
  vazioSub: { fontSize: 13, color: cores.textoMutado, textAlign: 'center', lineHeight: 20 },
  card: {
    backgroundColor: cores.fundoCard, borderRadius: 20,
    borderWidth: 0.5, borderColor: cores.borda, overflow: 'hidden',
  },
  cardUrgente: { borderColor: cores.primaria + '44' },
  cardImagem: {
    height: 160, backgroundColor: cores.fundoElevado,
    alignItems: 'center', justifyContent: 'center', position: 'relative',
  },
  fotoImagem: { width: '100%', height: '100%' },
  cardImagemIcone: { fontSize: 40, opacity: 0.15 },
  countdownPill: {
    position: 'absolute', top: 10, right: 10,
    backgroundColor: 'rgba(10,10,10,0.88)',
    borderWidth: 0.5, borderColor: cores.borda,
    borderRadius: 9, paddingHorizontal: 10, paddingVertical: 4,
    flexDirection: 'row', alignItems: 'center', gap: 5,
  },
  countdownUrgente: { borderColor: cores.primaria },
  countdownDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: cores.primaria },
  countdownTexto: { fontSize: 10, fontWeight: '500', color: cores.textoFraco },
  midiasbage: {
    position: 'absolute', bottom: 10, left: 10,
    backgroundColor: 'rgba(10,10,10,0.88)',
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4,
  },
  midiasTexto: { fontSize: 10, color: cores.textoForte },
  cardCorpo: { padding: 14 },
  cardTopo: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', marginBottom: 6, gap: 8,
  },
  cardTitulo: { flex: 1, fontSize: 14, fontWeight: '600', color: cores.textoForte, lineHeight: 20 },
  cardValor: { fontSize: 15, fontWeight: '700', color: cores.sucesso },
  cardLocalTexto: { fontSize: 12, color: cores.textoFraco, marginBottom: 12 },
  cardRodape: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardCategoria: { fontSize: 11, color: cores.textoMutado, textTransform: 'capitalize' },
  btnVerObra: {
    backgroundColor: cores.primaria, borderRadius: 9,
    paddingHorizontal: 14, paddingVertical: 7,
  },
  btnVerObraTexto: { fontSize: 11, fontWeight: '600', color: '#0A0A0A' },
})