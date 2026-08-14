import { GlassContainer, GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';

type PillProps = {
  clear?: boolean;
  compact?: boolean;
  icon?: string;
  scope?: string;
  term: string;
  tint?: string;
};

const concepts = [
  { id: 1, name: 'Crystal Segments', note: 'One continuous control with crisp internal divisions.' },
  { id: 2, name: 'Paired Droplets', note: 'Scope and term are separate droplets that visually attract.' },
  { id: 3, name: 'Compact Tokens', note: 'Small, quiet tokens for fitting several terms above the keyboard.' },
  { id: 4, name: 'Chromatic Scope', note: 'A restrained blue tint makes the editable scope obvious.' },
  { id: 5, name: 'Orbital Controls', note: 'The scope and remove actions become tactile circular satellites.' },
  { id: 6, name: 'Search Rail', note: 'Both terms share one floating glass rail, like compact toolbar items.' },
  { id: 7, name: 'Icon Scope', note: 'An SF-style symbol replaces the repeated “Anywhere” label.' },
  { id: 8, name: 'Clear Crystal', note: 'Thinner clear glass prioritizes the content underneath.' },
  { id: 9, name: 'Soft Tint', note: 'Each term gets a subtle semantic tint without becoming a badge.' },
  { id: 10, name: 'Magnetic Cluster', note: 'Independent pieces sit close enough to merge while interacting.' },
];

export function SearchPillLab() {
  const dark = useColorScheme() === 'dark';
  const [favorite, setFavorite] = useState<number | null>(null);
  const colors = dark
    ? { background: '#09090b', text: '#f7f7f8', secondary: '#aaaab2', card: '#17171a' }
    : { background: '#f2f2f7', text: '#111114', secondary: '#6e6e76', card: '#ffffff' };

  const choose = (id: number) => {
    setFavorite(id);
    void Haptics.selectionAsync();
  };

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.background }}>
      <View style={styles.intro}>
        <Text style={[styles.introTitle, { color: colors.text }]}>Ten directions</Text>
        <Text style={[styles.introCopy, { color: colors.secondary }]}>Tap a design to mark it. Every sample uses real system Liquid Glass over the same colorful canvas.</Text>
        {!isLiquidGlassAvailable() && <Text style={styles.warning}>Liquid Glass is unavailable on this OS; fallback rendering is shown.</Text>}
      </View>

      {concepts.map((concept) => (
        <Pressable key={concept.id} onPress={() => choose(concept.id)} style={({ pressed }) => [{ opacity: pressed ? 0.82 : 1 }]}>
          <View style={[styles.card, { backgroundColor: colors.card }, favorite === concept.id && styles.selectedCard]}>
            <View style={styles.cardHeading}>
              <View style={styles.numberBadge}><Text style={styles.numberText}>{concept.id}</Text></View>
              <View style={styles.headingCopy}>
                <Text style={[styles.name, { color: colors.text }]}>{concept.name}</Text>
                <Text style={[styles.note, { color: colors.secondary }]}>{concept.note}</Text>
              </View>
              {favorite === concept.id && <Text style={styles.check}>✓</Text>}
            </View>
            <ConceptCanvas concept={concept.id} />
          </View>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function ConceptCanvas({ concept }: { concept: number }) {
  return (
    <View style={styles.canvas}>
      <LinearGradient colors={['#3855ff', '#a636e8', '#ff6e62']} end={{ x: 1, y: 1 }} start={{ x: 0, y: 0 }} style={StyleSheet.absoluteFill} />
      <View style={[styles.glow, styles.glowOne]} />
      <View style={[styles.glow, styles.glowTwo]} />
      <View style={styles.sampleRow}>{renderConcept(concept)}</View>
    </View>
  );
}

function renderConcept(concept: number): ReactNode {
  switch (concept) {
    case 1:
      return <><Pill term="claude" /><Pill term="code" /></>;
    case 2:
      return <GlassContainer spacing={18} style={styles.row}><DropletPair term="claude" /><DropletPair term="code" /></GlassContainer>;
    case 3:
      return <><Pill compact term="claude" /><Pill compact term="code" /></>;
    case 4:
      return <><Pill term="claude" tint="rgba(10,132,255,0.28)" /><Pill term="code" tint="rgba(10,132,255,0.28)" /></>;
    case 5:
      return <GlassContainer spacing={10} style={styles.row}><Orbital term="claude" /><Orbital term="code" /></GlassContainer>;
    case 6:
      return <GlassView glassEffectStyle="regular" isInteractive style={styles.rail}><RailTerm term="claude" /><View style={styles.railDivider} /><RailTerm term="code" /></GlassView>;
    case 7:
      return <><Pill icon="⌕" scope="" term="claude" /><Pill icon="⌕" scope="" term="code" /></>;
    case 8:
      return <><Pill clear term="claude" /><Pill clear term="code" /></>;
    case 9:
      return <><Pill term="claude" tint="rgba(88,86,214,0.24)" /><Pill term="code" tint="rgba(255,159,10,0.22)" /></>;
    default:
      return <GlassContainer spacing={28} style={styles.row}><Magnetic term="claude" /><Magnetic term="code" /></GlassContainer>;
  }
}

function Pill({ clear, compact, icon, scope = 'Anywhere', term, tint }: PillProps) {
  return (
    <GlassView glassEffectStyle={clear ? 'clear' : 'regular'} isInteractive style={[styles.pill, compact && styles.compactPill]} tintColor={tint}>
      <View style={[styles.scope, compact && styles.compactScope]}>{icon && <Text style={styles.pillIcon}>{icon}</Text>}<Text style={styles.scopeText}>{scope}</Text>{scope && <Text style={styles.chevron}>⌄</Text>}</View>
      <View style={styles.divider} />
      <Text style={[styles.term, compact && styles.compactTerm]}>{term}</Text>
      <View style={styles.divider} />
      <Text style={styles.remove}>×</Text>
    </GlassView>
  );
}

function DropletPair({ term }: { term: string }) {
  return <View style={styles.cluster}><GlassView glassEffectStyle="regular" isInteractive style={styles.scopeDrop}><Text style={styles.scopeText}>Anywhere⌄</Text></GlassView><GlassView glassEffectStyle="regular" isInteractive style={styles.termDrop}><Text style={styles.term}>{term}</Text><Text style={styles.remove}>×</Text></GlassView></View>;
}

function Orbital({ term }: { term: string }) {
  return <View style={styles.cluster}><GlassView glassEffectStyle="regular" isInteractive style={styles.orb}><Text style={styles.orbText}>⌕</Text></GlassView><GlassView glassEffectStyle="regular" isInteractive style={styles.orbitTerm}><Text style={styles.term}>{term}</Text></GlassView><GlassView glassEffectStyle="regular" isInteractive style={styles.orb}><Text style={styles.remove}>×</Text></GlassView></View>;
}

function RailTerm({ term }: { term: string }) {
  return <View style={styles.railTerm}><Text style={styles.railScope}>Anywhere⌄</Text><Text style={styles.term}>{term}</Text><Text style={styles.remove}>×</Text></View>;
}

function Magnetic({ term }: { term: string }) {
  return <View style={styles.cluster}><GlassView glassEffectStyle="clear" isInteractive style={styles.magneticScope}><Text style={styles.scopeText}>Anywhere</Text></GlassView><GlassView glassEffectStyle="regular" isInteractive style={styles.magneticTerm}><Text style={styles.term}>{term}</Text><Text style={styles.remove}>×</Text></GlassView></View>;
}

const styles = StyleSheet.create({
  content: { gap: 14, padding: 16, paddingBottom: 40 },
  intro: { gap: 6, paddingHorizontal: 4, paddingVertical: 8 },
  introTitle: { fontSize: 28, fontWeight: '700', letterSpacing: -0.5 },
  introCopy: { fontSize: 15, lineHeight: 21 },
  warning: { color: '#ff9f0a', fontSize: 13, fontWeight: '600' },
  card: { borderCurve: 'continuous', borderRadius: 26, gap: 14, overflow: 'hidden', padding: 14 },
  selectedCard: { borderColor: '#0a84ff', borderWidth: 2, padding: 12 },
  cardHeading: { alignItems: 'center', flexDirection: 'row', gap: 10, paddingHorizontal: 2 },
  numberBadge: { alignItems: 'center', backgroundColor: '#0a84ff', borderRadius: 13, height: 26, justifyContent: 'center', width: 26 },
  numberText: { color: '#fff', fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  headingCopy: { flex: 1, gap: 2 },
  name: { fontSize: 17, fontWeight: '600' },
  note: { fontSize: 13, lineHeight: 17 },
  check: { color: '#0a84ff', fontSize: 22, fontWeight: '700' },
  canvas: { borderCurve: 'continuous', borderRadius: 20, height: 130, justifyContent: 'center', overflow: 'hidden' },
  glow: { borderRadius: 40, height: 80, opacity: 0.7, position: 'absolute', width: 80 },
  glowOne: { backgroundColor: '#ffcc00', left: 35, top: -30 },
  glowTwo: { backgroundColor: '#32d7ff', bottom: -38, right: 18 },
  sampleRow: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 12 },
  row: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  cluster: { alignItems: 'center', flexDirection: 'row', gap: 4 },
  pill: { alignItems: 'center', borderRadius: 18, flexDirection: 'row', height: 46, overflow: 'hidden' },
  compactPill: { borderRadius: 999, height: 36 },
  scope: { alignItems: 'center', flexDirection: 'row', gap: 3, paddingHorizontal: 10 },
  compactScope: { paddingHorizontal: 8 },
  pillIcon: { color: '#fff', fontSize: 18, fontWeight: '600' },
  scopeText: { color: 'rgba(255,255,255,0.92)', fontSize: 13, fontWeight: '600' },
  chevron: { color: 'rgba(255,255,255,0.72)', fontSize: 12 },
  divider: { backgroundColor: 'rgba(255,255,255,0.22)', height: 24, width: StyleSheet.hairlineWidth },
  term: { color: '#fff', fontSize: 14, fontWeight: '600', paddingHorizontal: 10 },
  compactTerm: { fontSize: 13, paddingHorizontal: 8 },
  remove: { color: 'rgba(255,255,255,0.86)', fontSize: 19, fontWeight: '400', paddingHorizontal: 9 },
  scopeDrop: { borderRadius: 18, justifyContent: 'center', height: 44, paddingHorizontal: 10 },
  termDrop: { alignItems: 'center', borderRadius: 18, flexDirection: 'row', height: 44 },
  orb: { alignItems: 'center', borderRadius: 21, height: 42, justifyContent: 'center', width: 42 },
  orbText: { color: '#fff', fontSize: 19, fontWeight: '600' },
  orbitTerm: { borderRadius: 18, height: 42, justifyContent: 'center' },
  rail: { alignItems: 'center', borderRadius: 20, flexDirection: 'row', height: 50, overflow: 'hidden' },
  railTerm: { alignItems: 'center', flexDirection: 'row' },
  railScope: { color: 'rgba(255,255,255,0.8)', fontSize: 11, fontWeight: '600', paddingLeft: 10 },
  railDivider: { backgroundColor: 'rgba(255,255,255,0.24)', height: 28, width: StyleSheet.hairlineWidth },
  magneticScope: { borderRadius: 17, justifyContent: 'center', height: 42, paddingHorizontal: 10 },
  magneticTerm: { alignItems: 'center', borderRadius: 17, flexDirection: 'row', height: 42 },
});
