import { Button, ControlGroup, Host, HStack, Menu } from '@expo/ui/swift-ui';
import { buttonBorderShape, buttonStyle, controlSize, glassEffect, labelStyle, tint } from '@expo/ui/swift-ui/modifiers';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useColorScheme } from 'react-native';

type NativeControlSize = 'mini' | 'small' | 'regular';

type Concept = {
  accent?: string;
  destructiveRemove?: boolean;
  id: number;
  name: string;
  note: string;
  scopeIcon?: 'magnifyingglass' | 'line.3.horizontal.decrease';
  scopeLabel: string;
  size: NativeControlSize;
  termAccent?: string;
  titleOnly?: boolean;
};

const concepts: Concept[] = [
  { id: 1, name: 'Native Small', note: 'The baseline: native Menu, button, and xmark in one ControlGroup.', scopeLabel: 'Anywhere', size: 'small' },
  { id: 2, name: 'Native Mini', note: 'The densest system size for fitting many terms above the search bar.', scopeLabel: 'Anywhere', size: 'mini' },
  { id: 3, name: 'Comfortable Capsule', note: 'Regular control sizing with more breathing room and a larger tap target.', scopeLabel: 'Anywhere', size: 'regular' },
  { accent: '#0a84ff', id: 4, name: 'Blue Scope', note: 'System blue identifies the scope menu while the term stays neutral.', scopeLabel: 'Anywhere', size: 'small' },
  { id: 5, name: 'Search Icon + Scope', note: 'The native magnifying-glass symbol reinforces that the first segment changes scope.', scopeIcon: 'magnifyingglass', scopeLabel: 'Anywhere', size: 'small' },
  { id: 6, name: 'Compact “All”', note: 'Shortens Anywhere to All for the most economical repeated token.', scopeIcon: 'magnifyingglass', scopeLabel: 'All', size: 'small' },
  { id: 7, name: 'Filter Scope', note: 'A filter symbol makes advanced search intent explicit without a custom chevron.', scopeIcon: 'line.3.horizontal.decrease', scopeLabel: 'Anywhere', size: 'small' },
  { accent: '#bf5af2', id: 8, name: 'Violet Scope', note: 'A softer semantic tint separates filters from ordinary toolbar controls.', scopeLabel: 'Anywhere', size: 'small' },
  { destructiveRemove: true, id: 9, name: 'Destructive Remove', note: 'The native destructive role gives the remove action clearer affordance.', scopeLabel: 'Anywhere', size: 'small' },
  { accent: '#0a84ff', id: 10, name: 'Dual Accent', note: 'Scope and term share one restrained tint for a more active search state.', scopeLabel: 'All', size: 'small', termAccent: '#0a84ff' },
];

export function SearchPillLab() {
  const dark = useColorScheme() === 'dark';
  const [favorite, setFavorite] = useState<number | null>(null);
  const colors = dark
    ? { background: '#09090b', card: '#17171a', secondary: '#aaaab2', text: '#f7f7f8' }
    : { background: '#f2f2f7', card: '#ffffff', secondary: '#6e6e76', text: '#111114' };

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
        <Text style={[styles.introTitle, { color: colors.text }]}>Compact Token Lab</Text>
        <Text style={[styles.introCopy, { color: colors.secondary }]}>All ten now use SwiftUI’s real ControlGroup. The system owns the capsule, dividers, menu chevron, press behavior, and xmark.</Text>
      </View>

      {concepts.map((concept) => (
        <Pressable key={concept.id} onPress={() => choose(concept.id)} style={({ pressed }) => ({ opacity: pressed ? 0.82 : 1 })}>
          <View style={[styles.card, { backgroundColor: colors.card }, favorite === concept.id && styles.selectedCard]}>
            <View style={styles.cardHeading}>
              <View style={styles.numberBadge}><Text style={styles.numberText}>{concept.id}</Text></View>
              <View style={styles.headingCopy}>
                <Text style={[styles.name, { color: colors.text }]}>{concept.name}</Text>
                <Text style={[styles.note, { color: colors.secondary }]}>{concept.note}</Text>
              </View>
              {favorite === concept.id && <Text style={styles.check}>✓</Text>}
            </View>
            <ConceptCanvas concept={concept} dark={dark} />
          </View>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function ConceptCanvas({ concept, dark }: { concept: Concept; dark: boolean }) {
  return (
    <View style={styles.canvas}>
      <LinearGradient colors={['#3855ff', '#a636e8', '#ff6e62']} end={{ x: 1, y: 1 }} start={{ x: 0, y: 0 }} style={StyleSheet.absoluteFill} />
      <View style={[styles.glow, styles.glowOne]} />
      <View style={[styles.glow, styles.glowTwo]} />
      <Host colorScheme={dark ? 'dark' : 'light'} style={styles.host}>
        <HStack spacing={8}>
          <NativeToken concept={concept} term="claude" />
          <NativeToken concept={concept} term="code" />
        </HStack>
      </Host>
    </View>
  );
}

function NativeToken({ concept, term }: { concept: Concept; term: string }) {
  const groupModifiers = [
    buttonStyle('plain'),
    buttonBorderShape('capsule'),
    controlSize(concept.size),
    glassEffect({
      glass: {
        variant: 'regular',
        interactive: true,
        tint: concept.accent,
      },
      shape: 'capsule',
    }),
  ];
  const scopeModifiers = concept.accent ? [tint(concept.accent)] : [];
  const termModifiers = concept.termAccent ? [tint(concept.termAccent)] : [];

  return (
    <ControlGroup modifiers={groupModifiers}>
      <Menu
        label={concept.scopeLabel}
        modifiers={scopeModifiers}
        systemImage={concept.scopeIcon}>
        <Button label="Anywhere" systemImage="text.magnifyingglass" />
        <Button label="From" systemImage="person" />
        <Button label="To" systemImage="arrow.right" />
        <Button label="Subject" systemImage="text.alignleft" />
        <Button label="Body" systemImage="doc.text" />
      </Menu>
      <Button label={term} modifiers={termModifiers} />
      <Button
        modifiers={[labelStyle('iconOnly')]}
        role={concept.destructiveRemove ? 'destructive' : 'default'}
        systemImage="xmark"
      />
    </ControlGroup>
  );
}

const styles = StyleSheet.create({
  content: { gap: 14, padding: 16, paddingBottom: 40 },
  intro: { gap: 6, paddingHorizontal: 4, paddingVertical: 8 },
  introTitle: { fontSize: 28, fontWeight: '700', letterSpacing: -0.5 },
  introCopy: { fontSize: 15, lineHeight: 21 },
  card: { borderCurve: 'continuous', borderRadius: 26, gap: 14, overflow: 'hidden', padding: 14 },
  selectedCard: { borderColor: '#0a84ff', borderWidth: 2, padding: 12 },
  cardHeading: { alignItems: 'center', flexDirection: 'row', gap: 10, paddingHorizontal: 2 },
  numberBadge: { alignItems: 'center', backgroundColor: '#0a84ff', borderRadius: 13, height: 26, justifyContent: 'center', width: 26 },
  numberText: { color: '#fff', fontSize: 13, fontVariant: ['tabular-nums'], fontWeight: '700' },
  headingCopy: { flex: 1, gap: 2 },
  name: { fontSize: 17, fontWeight: '600' },
  note: { fontSize: 13, lineHeight: 17 },
  check: { color: '#0a84ff', fontSize: 22, fontWeight: '700' },
  canvas: { borderCurve: 'continuous', borderRadius: 20, height: 126, overflow: 'hidden' },
  glow: { borderRadius: 40, height: 80, opacity: 0.7, position: 'absolute', width: 80 },
  glowOne: { backgroundColor: '#ffcc00', left: 35, top: -30 },
  glowTwo: { backgroundColor: '#32d7ff', bottom: -38, right: 18 },
  host: { alignItems: 'center', height: 126, justifyContent: 'center', width: '100%' },
});
