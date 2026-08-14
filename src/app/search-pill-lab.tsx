import { SearchPillLab } from '@/components/search-pill-lab';
import { Stack } from 'expo-router';

export default function SearchPillLabScreen() {
  return (
    <>
      <Stack.Screen options={{ headerBackButtonDisplayMode: 'minimal', headerShown: true, title: 'Search Pill Lab' }} />
      <SearchPillLab />
    </>
  );
}
