import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  LayoutAnimation,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from 'react-native';
import * as Speech from 'expo-speech';
import RNBluetoothClassic, {
  BluetoothDevice,
  BluetoothEventSubscription,
} from 'react-native-bluetooth-classic';

let Haptics: any = null;
try {
  // Optional dep — the UI still works without it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Haptics = require('expo-haptics');
} catch {
  Haptics = null;
}

if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const TARGET_NAME = 'NSL_Glove';
const RECONNECT_DELAY_MS = 2500;
const MAX_LOG_LINES = 400;

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg: '#F4F4F2',
  surface: '#FFFFFF',
  surfaceHi: '#FBFBFA',
  border: '#E3E3E0',
  textHi: '#0B0B0C',
  textMid: '#8A8A8E',
  textLow: '#B4B4B6',
  accent: '#0B0B0C',
  success: '#0B0B0C',
  warning: '#8A8A8E',
  danger: '#B00020',
};

const S = { s4: 4, s8: 8, s12: 12, s16: 16, s24: 24, s32: 32, s48: 48 };
const R = { btn: 12, card: 20, pill: 999 };
const PAGE = 20;

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'Courier' });

// ── Types & helpers (behavior unchanged) ──────────────────────────────────────
type LogEntry = {
  id: string;
  ts: string;
  dir: 'in' | 'out' | 'sys';
  text: string;
};

type Status = 'disconnected' | 'connecting' | 'connected';

const now = () => {
  const d = new Date();
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const shouldSpeak = (line: string) => {
  if (!line) return false;
  if (line.startsWith('>>')) return false;
  if (line.startsWith('!!')) return false;
  if (line.startsWith('=')) return false;
  if (line.startsWith('   ')) return false;
  return true;
};

const lastWordOf = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1];
};

const isErrorLine = (t: string) => /error|fail/i.test(t);

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [status, setStatus] = useState<Status>('disconnected');
  const [devices, setDevices] = useState<BluetoothDevice[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [connectedDevice, setConnectedDevice] = useState<BluetoothDevice | null>(null);
  const [word, setWord] = useState('');
  const [trainText, setTrainText] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [logOpen, setLogOpen] = useState(false);

  const readSubRef = useRef<BluetoothEventSubscription | null>(null);
  const disconnectSubRef = useRef<BluetoothEventSubscription | null>(null);
  const bufferRef = useRef<string>('');
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTargetRef = useRef<BluetoothDevice | null>(null);
  const logListRef = useRef<FlatList<LogEntry>>(null);
  const logIdRef = useRef(0);

  // Hero animation
  const opacity = useRef(new Animated.Value(1)).current;
  const scale = useRef(new Animated.Value(1)).current;

  const animateHero = useCallback(() => {
    opacity.setValue(0);
    scale.setValue(0.96);
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: 1,
        speed: 18,
        bounciness: 4,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, scale]);

  const appendLog = useCallback((dir: LogEntry['dir'], text: string) => {
    setLog((prev) => {
      const id = `${Date.now()}-${logIdRef.current++}`;
      const next = [...prev, { id, ts: now(), dir, text }];
      if (next.length > MAX_LOG_LINES) next.splice(0, next.length - MAX_LOG_LINES);
      return next;
    });
  }, []);

  const clearLog = useCallback(() => setLog([]), []);

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10);
    try {
      if (apiLevel >= 31) {
        const result = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        ]);
        return (
          result['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED &&
          result['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED
        );
      }
      const fine = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      );
      return fine === PermissionsAndroid.RESULTS.GRANTED;
    } catch (e) {
      appendLog('sys', `Permission error: ${String(e)}`);
      return false;
    }
  }, [appendLog]);

  const teardownConnection = useCallback(() => {
    readSubRef.current?.remove();
    readSubRef.current = null;
    disconnectSubRef.current?.remove();
    disconnectSubRef.current = null;
    bufferRef.current = '';
  }, []);

  const handleIncoming = useCallback(
    (chunk: string) => {
      // connect() was called with delimiter: '\n', so each event carries one
      // complete line with the delimiter stripped. Drain the buffer every
      // event — holding the tail back would strand every line forever.
      bufferRef.current += chunk;
      const parts = bufferRef.current.split(/\r?\n/);
      bufferRef.current = '';
      for (const raw of parts) {
        const line = raw.replace(/\r$/, '');
        if (!line.length) continue;
        appendLog('in', line);
        if (shouldSpeak(line)) {
          const w = lastWordOf(line);
          if (w) {
            setWord(w);
            animateHero();
            Haptics?.impactAsync?.(Haptics?.ImpactFeedbackStyle?.Light);
          }
          Speech.stop();
          Speech.speak(line, { language: 'en-US', rate: 1.0 });
        }
      }
    },
    [appendLog, animateHero],
  );

  const attachDeviceListeners = useCallback(
    (device: BluetoothDevice) => {
      readSubRef.current = device.onDataReceived((event) => {
        handleIncoming(event.data ?? '');
      });
      disconnectSubRef.current = RNBluetoothClassic.onDeviceDisconnected((event) => {
        if (event.address === device.address) {
          appendLog('sys', `Disconnected from ${device.name}`);
          teardownConnection();
          setConnectedDevice(null);
          setStatus('disconnected');
          if (autoReconnect && lastTargetRef.current) {
            scheduleReconnect();
          }
        }
      });
    },
    [appendLog, autoReconnect, handleIncoming, teardownConnection],
  );

  const connectToDevice = useCallback(
    async (device: BluetoothDevice) => {
      if (status === 'connecting') return;
      lastTargetRef.current = device;
      setStatus('connecting');
      appendLog('sys', `Connecting to ${device.name} (${device.address})…`);
      try {
        const already = await device.isConnected();
        const connected = already ? device : await device.connect({ delimiter: '\n' });
        attachDeviceListeners(connected);
        setConnectedDevice(connected);
        setStatus('connected');
        appendLog('sys', `Connected to ${connected.name}`);
      } catch (e) {
        setStatus('disconnected');
        appendLog('sys', `Connect failed: ${String(e)}`);
        if (autoReconnect) scheduleReconnect();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status, appendLog, attachDeviceListeners, autoReconnect],
  );

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return;
    reconnectTimerRef.current = setTimeout(async () => {
      reconnectTimerRef.current = null;
      const target = lastTargetRef.current;
      if (!target) return;
      if (status === 'connected') return;
      appendLog('sys', 'Attempting auto-reconnect…');
      try {
        const bonded = await RNBluetoothClassic.getBondedDevices();
        const fresh = bonded.find((d) => d.address === target.address) ?? target;
        await connectToDevice(fresh);
      } catch (e) {
        appendLog('sys', `Reconnect error: ${String(e)}`);
        scheduleReconnect();
      }
    }, RECONNECT_DELAY_MS);
  }, [appendLog, connectToDevice, status]);

  const loadPaired = useCallback(
    async (autoConnect: boolean) => {
      const ok = await requestPermissions();
      if (!ok) {
        Alert.alert('Permissions required', 'Bluetooth permissions are needed to continue.');
        return;
      }
      try {
        const enabled = await RNBluetoothClassic.isBluetoothEnabled();
        if (!enabled) {
          try {
            await RNBluetoothClassic.requestBluetoothEnabled();
          } catch {
            appendLog('sys', 'Bluetooth is disabled.');
            return;
          }
        }
        const bonded = await RNBluetoothClassic.getBondedDevices();
        setDevices(bonded);
        appendLog('sys', `Found ${bonded.length} paired device(s).`);
        if (autoConnect) {
          const target = bonded.find((d) => d.name === TARGET_NAME);
          if (target) {
            await connectToDevice(target);
          } else if (bonded.length) {
            setPickerVisible(true);
          } else {
            Alert.alert('No paired devices', `Pair "${TARGET_NAME}" in Android Bluetooth settings first.`);
          }
        }
      } catch (e) {
        appendLog('sys', `Load paired error: ${String(e)}`);
      }
    },
    [appendLog, connectToDevice, requestPermissions],
  );

  const disconnect = useCallback(async () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setAutoReconnect(false);
    const dev = connectedDevice;
    teardownConnection();
    if (dev) {
      try {
        await dev.disconnect();
      } catch {
        // ignore
      }
      appendLog('sys', `Disconnected from ${dev.name}`);
    }
    setConnectedDevice(null);
    setStatus('disconnected');
  }, [appendLog, connectedDevice, teardownConnection]);

  const send = useCallback(
    async (cmd: string) => {
      if (!connectedDevice || status !== 'connected') {
        Alert.alert('Not connected', 'Connect to the glove first.');
        return;
      }
      const payload = cmd.endsWith('\n') ? cmd : cmd + '\n';
      try {
        await connectedDevice.write(payload);
        appendLog('out', payload.replace(/\n$/, ''));
      } catch (e) {
        appendLog('sys', `Send error: ${String(e)}`);
      }
    },
    [appendLog, connectedDevice, status],
  );

  const sendTrain = useCallback(() => {
    const t = trainText.trim();
    if (!t) return;
    send(`TRAIN:${t.toUpperCase()}`);
    setTrainText('');
  }, [send, trainText]);

  const sendDelete = useCallback(() => {
    const w = trainText.trim().toUpperCase();
    if (!w) {
      Alert.alert(
        'Type a word first',
        'Type the sign you want to delete in the field above.',
      );
      return;
    }
    Alert.alert(
      'Delete sign?',
      `This removes all samples of "${w}".`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            send(`DEL:${w}`);
            setTrainText('');
          },
        },
      ],
    );
  }, [send, trainText]);

  const onPillPress = useCallback(() => {
    if (status === 'connected') {
      disconnect();
    } else if (status === 'disconnected') {
      setAutoReconnect(true);
      loadPaired(true);
    }
  }, [status, disconnect, loadPaired]);

  const toggleLog = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setLogOpen((v) => !v);
  }, []);

  useEffect(() => {
    loadPaired(true);
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      teardownConnection();
      Speech.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (logOpen && log.length) logListRef.current?.scrollToEnd({ animated: true });
  }, [log, logOpen]);

  const statusMeta = useMemo(() => {
    if (status === 'connected') return { dot: C.success, label: 'Connected' };
    if (status === 'connecting') return { dot: C.warning, label: 'Connecting' };
    return { dot: C.textLow, label: 'Offline' };
  }, [status]);

  const displayWord = word ? word.toUpperCase() : '—';
  const trainDisplay = trainText.toUpperCase();

  const renderLogItem = ({ item }: { item: LogEntry }) => {
    const color =
      item.dir === 'in'
        ? C.textHi
        : item.dir === 'out'
        ? C.textMid
        : isErrorLine(item.text)
        ? C.danger
        : C.textLow;
    const marker =
      item.dir === 'in' ? '‹ ' : item.dir === 'out' ? '› ' : '  ';
    return (
      <Text style={styles.logLine} numberOfLines={2}>
        <Text style={styles.logTs}>{item.ts}  </Text>
        <Text style={{ color }}>{marker}{item.text}</Text>
      </Text>
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={C.bg} />

      {/* HEADER */}
      <View style={styles.header}>
        <Text style={styles.brand}>NSL Glove</Text>
        <Pressable
          onPress={onPillPress}
          hitSlop={8}
          style={({ pressed }) => [
            styles.pill,
            { backgroundColor: pressed ? C.surfaceHi : C.surface },
          ]}
        >
          <View
            style={[
              styles.statusSquare,
              status === 'connected'
                ? { backgroundColor: C.textHi, borderColor: C.textHi }
                : { backgroundColor: 'transparent', borderColor: C.textHi },
            ]}
          />
          <Text style={styles.pillLabel}>{statusMeta.label}</Text>
          {status === 'connecting' ? (
            <ActivityIndicator size="small" color={C.textHi} style={{ marginLeft: 6 }} />
          ) : null}
        </Pressable>
      </View>

      {/* HERO */}
      <View style={styles.hero}>
        <Text style={styles.heroCaption}>LAST SIGN</Text>
        <Animated.Text
          style={[styles.heroWord, { opacity, transform: [{ scale }] }]}
          adjustsFontSizeToFit
          numberOfLines={1}
          minimumFontScale={0.3}
        >
          {displayWord}
        </Animated.Text>
        {word ? <Text style={styles.heroSubline}>Spoken just now</Text> : null}
      </View>

      {/* BODY */}
      <View style={styles.body}>
        {/* TRAIN CARD */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Record a new sign</Text>
          <TextInput
            style={styles.input}
            value={trainDisplay}
            onChangeText={(t) => setTrainText(t)}
            placeholder="Type the word…"
            placeholderTextColor={C.textLow}
            autoCapitalize="characters"
            autoCorrect={false}
            selectionColor={C.accent}
            returnKeyType="send"
            onSubmitEditing={sendTrain}
          />
          <Pressable
            onPress={sendTrain}
            disabled={!trainText.trim()}
            style={({ pressed }) => [
              styles.primaryBtn,
              {
                opacity: !trainText.trim() ? 0.4 : pressed ? 0.85 : 1,
              },
            ]}
          >
            <Text style={styles.primaryBtnText}>Record</Text>
          </Pressable>
        </View>

        {/* COMMAND GRID */}
        <View style={styles.grid}>
          {(
            [
              { cmd: 'CAL', variant: 'default' },
              { cmd: 'LIST', variant: 'default' },
              { cmd: 'RAW', variant: 'default' },
              { cmd: 'SAVE', variant: 'filled' },
              { cmd: 'DONE', variant: 'default' },
              { cmd: 'DEL', variant: 'destructive' },
            ] as const
          ).map(({ cmd, variant }) => {
            const onPress =
              cmd === 'DEL' ? sendDelete : () => send(cmd);
            return (
              <Pressable
                key={cmd}
                onPress={onPress}
                style={({ pressed }) => [
                  styles.gridBtn,
                  variant === 'filled' && styles.gridBtnFilled,
                  variant === 'destructive' && styles.gridBtnDestructive,
                  { opacity: pressed ? 0.75 : 1 },
                ]}
              >
                <Text
                  style={[
                    styles.gridBtnText,
                    variant === 'filled' && styles.gridBtnTextFilled,
                    variant === 'destructive' && styles.gridBtnTextDestructive,
                  ]}
                >
                  {cmd}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* ACTIVITY LOG */}
        <View style={styles.activityWrap}>
          <Pressable
            onPress={toggleLog}
            style={({ pressed }) => [
              styles.activityHeader,
              { opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={styles.activityTitle}>Activity</Text>
            <Text style={styles.chevron}>{logOpen ? '⌃' : '⌄'}</Text>
          </Pressable>

          {logOpen ? (
            <View style={styles.activityBody}>
              <FlatList
                ref={logListRef}
                style={styles.logList}
                contentContainerStyle={styles.logContent}
                data={log}
                keyExtractor={(i) => i.id}
                renderItem={renderLogItem}
                onContentSizeChange={() => logListRef.current?.scrollToEnd({ animated: true })}
              />
              <Pressable onPress={clearLog} hitSlop={8} style={styles.clearLink}>
                <Text style={styles.clearLinkText}>Clear</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>

      {/* DEVICE PICKER */}
      <Modal
        visible={pickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Choose a paired device</Text>
            <ScrollView style={{ maxHeight: 320 }}>
              {devices.map((d) => (
                <Pressable
                  key={d.address}
                  onPress={() => {
                    setPickerVisible(false);
                    connectToDevice(d);
                  }}
                  style={({ pressed }) => [
                    styles.deviceRow,
                    { backgroundColor: pressed ? C.surfaceHi : 'transparent' },
                  ]}
                >
                  <Text style={styles.deviceName}>{d.name || '(unnamed)'}</Text>
                  <Text style={styles.deviceAddr}>{d.address}</Text>
                </Pressable>
              ))}
              {devices.length === 0 ? (
                <Text style={styles.deviceAddr}>No paired devices found.</Text>
              ) : null}
            </ScrollView>
            <Pressable
              onPress={() => setPickerVisible(false)}
              style={({ pressed }) => [
                styles.modalCancel,
                { opacity: pressed ? 0.6 : 1 },
              ]}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: PAGE,
    paddingTop: S.s16,
    paddingBottom: S.s8,
  },
  brand: {
    color: C.textHi,
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
  },
  statusSquare: {
    width: 9,
    height: 9,
    borderRadius: 2,
    borderWidth: 1.5,
    marginRight: S.s8,
  },
  pillLabel: {
    color: C.textHi,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },

  // Hero
  hero: {
    marginHorizontal: PAGE,
    marginTop: S.s8,
    marginBottom: S.s16,
    paddingVertical: S.s48,
    paddingHorizontal: PAGE,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroWord: {
    color: C.textHi,
    fontSize: 96,
    fontWeight: '700',
    letterSpacing: -3,
    textAlign: 'center',
    lineHeight: 104,
    marginVertical: S.s16,
  },
  heroCaption: {
    color: C.textMid,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 3,
    textTransform: 'uppercase',
  },
  heroSubline: {
    marginTop: S.s8,
    color: C.textMid,
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  // Body
  body: {
    paddingHorizontal: PAGE,
    paddingBottom: S.s24,
    gap: S.s16,
  },

  // Train card
  card: {
    backgroundColor: C.surface,
    borderRadius: R.card,
    padding: S.s16,
    gap: S.s12,
    borderWidth: 1,
    borderColor: C.border,
  },
  cardLabel: {
    color: C.textMid,
    fontSize: 13,
    fontWeight: '500',
  },
  input: {
    backgroundColor: C.surfaceHi,
    borderRadius: R.btn,
    height: 48,
    paddingHorizontal: S.s16,
    color: C.textHi,
    fontSize: 17,
    fontWeight: '500',
  },
  primaryBtn: {
    height: 48,
    borderRadius: R.btn,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },

  // Command grid (3x2)
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  gridBtn: {
    flexGrow: 1,
    flexBasis: '30%',
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 16,
  },
  gridBtnFilled: {
    backgroundColor: C.textHi,
    borderColor: C.textHi,
  },
  gridBtnDestructive: {
    borderColor: '#EAD4D6',
  },
  gridBtnText: {
    color: C.textHi,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  gridBtnTextFilled: {
    color: '#FFFFFF',
  },
  gridBtnTextDestructive: {
    color: C.danger,
  },

  // Activity
  activityWrap: {
    gap: S.s8,
  },
  activityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: S.s8,
  },
  activityTitle: {
    color: C.textMid,
    fontSize: 15,
    fontWeight: '500',
  },
  chevron: {
    color: C.textMid,
    fontSize: 15,
    fontWeight: '500',
  },
  activityBody: {
    backgroundColor: C.surface,
    borderRadius: R.card,
    padding: S.s12,
    gap: S.s8,
  },
  logList: {
    maxHeight: 220,
  },
  logContent: {
    paddingBottom: S.s4,
  },
  logLine: {
    fontFamily: MONO,
    fontSize: 12,
    lineHeight: 18,
  },
  logTs: {
    color: C.textLow,
    fontFamily: MONO,
    fontSize: 12,
  },
  clearLink: {
    alignSelf: 'flex-end',
    paddingVertical: S.s4,
  },
  clearLinkText: {
    color: C.textLow,
    fontSize: 13,
    fontWeight: '500',
  },

  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    padding: PAGE,
  },
  modalCard: {
    backgroundColor: C.surface,
    borderRadius: R.card,
    padding: S.s16,
    gap: S.s8,
  },
  modalTitle: {
    color: C.textHi,
    fontSize: 17,
    fontWeight: '600',
    marginBottom: S.s8,
  },
  deviceRow: {
    paddingVertical: S.s12,
    paddingHorizontal: S.s8,
    borderRadius: R.btn,
  },
  deviceName: {
    color: C.textHi,
    fontSize: 15,
    fontWeight: '500',
  },
  deviceAddr: {
    color: C.textLow,
    fontSize: 13,
    marginTop: 2,
  },
  modalCancel: {
    marginTop: S.s8,
    height: 48,
    borderRadius: R.btn,
    backgroundColor: C.surfaceHi,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCancelText: {
    color: C.textHi,
    fontSize: 15,
    fontWeight: '500',
  },
});
