import { desc } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';

import { db } from '../db/client';
import { createFollowUp, setFollowUpStatus } from '../db/mutations';
import { followUps, type FollowUp } from '../db/schema';
import { styles } from './styles';

/**
 * The shared list — the one entity several people edit at once, which is what
 * makes a same-field conflict happen naturally instead of being contrived.
 *
 * Toggling status records what this device BELIEVED the status was. If the
 * server finds that belief no longer holds, it rejects the operation and the
 * row snaps back here on the next sync.
 */
export function FollowUpsScreen() {
  const [title, setTitle] = useState('');

  const { data: items } = useLiveQuery(
    db.select().from(followUps).orderBy(desc(followUps.createdAt)),
  );

  const canSubmit = title.trim().length > 0;

  async function add() {
    if (!canSubmit) return;
    await createFollowUp(title.trim());
    setTitle('');
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.form}>
        <Text style={styles.title}>Follow-ups</Text>
        <TextInput
          style={styles.input}
          placeholder="What needs following up?"
          value={title}
          onChangeText={setTitle}
        />
        <Pressable
          style={[styles.button, !canSubmit && styles.buttonDisabled]}
          onPress={add}
          disabled={!canSubmit}
        >
          <Text style={styles.buttonLabel}>Add item</Text>
        </Pressable>
      </View>

      <FlatList
        data={items ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={<Text style={styles.muted}>Nothing on the list.</Text>}
        renderItem={({ item }) => <FollowUpRow item={item} />}
        keyboardShouldPersistTaps="handled"
      />
    </KeyboardAvoidingView>
  );
}

function FollowUpRow({ item }: { item: FollowUp }) {
  const done = item.status === 'done';

  return (
    <Pressable
      style={[styles.row, styles.followUpRow]}
      onPress={() => setFollowUpStatus(item, done ? 'open' : 'done')}
    >
      <View style={[styles.checkbox, done && styles.checkboxDone]}>
        {done && <Text style={styles.checkboxMark}>✓</Text>}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.followUpTitle, done && styles.followUpDone]}>
          {item.title}
        </Text>
        <Text style={styles.rowMeta}>
          {item.id.slice(0, 8)} · {item.status}
        </Text>
      </View>
    </Pressable>
  );
}
