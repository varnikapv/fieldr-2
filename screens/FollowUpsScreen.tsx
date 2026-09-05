import { desc } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';

import { db } from '../db/client';
import { createFollowUp, setFollowUpStatus } from '../db/mutations';
import { followUps, type FollowUp } from '../db/schema';
import { usePendingIds, useRejectedIds } from '../hooks/useSyncBadges';
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

  const pendingIds = usePendingIds('follow_ups');
  const rejectedIds = useRejectedIds('follow_ups');

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
        renderItem={({ item }) => (
          <FollowUpRow
            item={item}
            pending={pendingIds.has(item.id)}
            rejected={rejectedIds.has(item.id)}
          />
        )}
        keyboardShouldPersistTaps="handled"
      />
    </KeyboardAvoidingView>
  );
}

/**
 * The badge bridges pending -> rejected rather than disappearing.
 *
 * When the server refuses an operation, three things happen at once on the
 * losing device: the value reverts (replay excludes the rejected operation),
 * the operation stops being pending, and the explanation appears on another
 * tab. If the indicator simply vanished, that would read as a change quietly
 * undoing itself — the exact feeling this project exists to eliminate. So the
 * clock becomes a warning in place, and stays.
 */
function FollowUpRow({
  item,
  pending,
  rejected,
}: {
  item: FollowUp;
  pending: boolean;
  rejected: boolean;
}) {
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
        <View style={styles.badgeRow}>
          <Text style={styles.rowMeta}>
            {item.id.slice(0, 8)} · {item.status}
          </Text>
          {pending && <Text style={styles.badgePending}>◷</Text>}
          {!pending && rejected && (
            <Text style={styles.badgeRejected}>⚠ not applied</Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}
