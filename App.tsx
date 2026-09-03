import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { NavigationContainer } from '@react-navigation/native';
import { useMigrations } from 'drizzle-orm/expo-sqlite/migrator';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { db } from './db/client';
import migrations from './drizzle/migrations';
import { FollowUpsScreen } from './screens/FollowUpsScreen';
import { SyncInspectorScreen } from './screens/SyncInspectorScreen';
import { styles } from './screens/styles';
import { VisitsScreen } from './screens/VisitsScreen';

const Tab = createBottomTabNavigator();

export default function App() {
  // Migrations run once per device on boot. drizzle records which ones have
  // already been applied, so this is a no-op on every launch after the first.
  const { success, error } = useMigrations(db, migrations);

  if (error) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.errorTitle}>Migration failed</Text>
        <Text style={styles.errorBody}>{error.message}</Text>
      </View>
    );
  }

  if (!success) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator />
        <Text style={styles.muted}>Running migrations…</Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <StatusBar style="auto" />
        <Tab.Navigator screenOptions={{ headerShown: false }}>
          <Tab.Screen name="Visits" component={VisitsScreen} />
          <Tab.Screen name="Follow-ups" component={FollowUpsScreen} />
          <Tab.Screen name="Sync" component={SyncInspectorScreen} />
        </Tab.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
