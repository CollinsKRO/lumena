import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import Constants from "expo-constants";
import { ExpoSecureStoreKeyStorage, LumenNativeProvider, useCreateWallet, useWallet } from "@lumen/react-native";
import { LumenClient } from "@lumen/web-sdk";
import { Asset } from "@stellar/stellar-sdk";

interface Runtime {
  client: LumenClient;
  storage: ExpoSecureStoreKeyStorage;
}

export default function App() {
  const [runtime, setRuntime] = useState<Runtime>();
  const [initializationError, setInitializationError] = useState<string>();

  useEffect(() => {
    let active = true;
    const extra = Constants.expoConfig?.extra;
    const serverUrl = extra?.lumenServerUrl;
    const serverPublicKey = extra?.lumenCosignerPublicKey;

    if (typeof serverUrl !== "string" || typeof serverPublicKey !== "string") {
      setInitializationError(
        "Set EXPO_PUBLIC_LUMEN_SERVER_URL and EXPO_PUBLIC_LUMEN_COSIGNER_PUBLIC_KEY before starting the app.",
      );
      return;
    }

    const storage = new ExpoSecureStoreKeyStorage();
    void storage.initialize().then(
      () => {
        if (!active) return;
        setRuntime({
          storage,
          client: new LumenClient({
            network: "testnet",
            serverUrl,
            serverPublicKey,
          }),
        });
      },
      (error: unknown) => {
        if (active) {
          setInitializationError(
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    );

    return () => {
      active = false;
    };
  }, []);

  if (initializationError) {
    return <Message text={initializationError} />;
  }
  if (!runtime) {
    return <ActivityIndicator style={styles.centered} />;
  }

  return (
    <LumenNativeProvider client={runtime.client} storage={runtime.storage}>
      <WalletScreen />
    </LumenNativeProvider>
  );
}

function WalletScreen() {
  const [walletId, setWalletId] = useState<string>();
  const [passphrase, setPassphrase] = useState("");
  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("1");
  const [transactionStatus, setTransactionStatus] = useState<string>();
  const { createWallet, loading, error, data, recovery } = useCreateWallet();
  const { wallet } = useWallet(walletId ?? "");

  async function onCreateWallet() {
    try {
      const result = await createWallet(passphrase);
      setWalletId(result.id);
      setPassphrase("");
    } catch {
      // The hook exposes the error state for rendering below.
    }
  }

  async function onSendPayment() {
    if (!wallet) return;
    setTransactionStatus(undefined);
    try {
      const result = await wallet.send(destination.trim(), Asset.native(), amount.trim());
      setTransactionStatus(`Co-signed transaction submitted: ${result.hash}`);
    } catch (sendError) {
      setTransactionStatus(
        sendError instanceof Error ? sendError.message : String(sendError),
      );
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Lumen Native Wallet</Text>
        <Text style={styles.description}>
          Create a testnet wallet. Its mnemonic-derived signer is encrypted in
          Expo SecureStore, and payments are submitted through the Lumen
          co-signer.
        </Text>

        {!walletId ? (
          <View style={styles.card}>
            <Text style={styles.label}>Wallet encryption passphrase</Text>
            <TextInput
              accessibilityLabel="Wallet encryption passphrase"
              autoCapitalize="none"
              onChangeText={setPassphrase}
              placeholder="Choose a strong passphrase"
              secureTextEntry
              style={styles.input}
              value={passphrase}
            />
            <TouchableOpacity
              accessibilityRole="button"
              disabled={loading || passphrase.length === 0}
              onPress={() => void onCreateWallet()}
              style={[styles.button, (loading || !passphrase) && styles.disabled]}
            >
              <Text style={styles.buttonText}>
                {loading ? "Creating wallet..." : "Create wallet"}
              </Text>
            </TouchableOpacity>
            {loading && <ActivityIndicator />}
            {error && <Text style={styles.error}>{error.message}</Text>}
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.label}>Wallet address</Text>
            <Text selectable style={styles.address}>{data?.address ?? walletId}</Text>
            <Text style={styles.label}>Payment destination</Text>
            <TextInput
              accessibilityLabel="Payment destination"
              autoCapitalize="none"
              onChangeText={setDestination}
              placeholder="Stellar testnet address"
              style={styles.input}
              value={destination}
            />
            <Text style={styles.label}>Amount in XLM</Text>
            <TextInput
              accessibilityLabel="Amount in XLM"
              keyboardType="decimal-pad"
              onChangeText={setAmount}
              style={styles.input}
              value={amount}
            />
            <TouchableOpacity
              accessibilityRole="button"
              disabled={!wallet || destination.trim().length === 0}
              onPress={() => void onSendPayment()}
              style={[
                styles.button,
                (!wallet || !destination.trim()) && styles.disabled,
              ]}
            >
              <Text style={styles.buttonText}>Send co-signed payment</Text>
            </TouchableOpacity>
            {transactionStatus && <Text selectable>{transactionStatus}</Text>}
          </View>
        )}

        {(data?.mnemonic || recovery?.mnemonic) && (
          <View style={styles.warning}>
            <Text style={styles.label}>Recovery phrase — write it down now</Text>
            <Text selectable style={styles.address}>
              {data?.mnemonic ?? recovery?.mnemonic}
            </Text>
            <Text style={styles.description}>
              Keep it private and offline. If wallet setup failed, this phrase
              still recovers the locally generated signer.
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Message({ text }: { text: string }) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <Text style={styles.error}>{text}</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#f7f8fa" },
  centered: { flex: 1 },
  content: { gap: 16, padding: 24 },
  title: { color: "#172033", fontSize: 28, fontWeight: "700" },
  description: { color: "#596579", fontSize: 15, lineHeight: 22 },
  card: { backgroundColor: "#fff", borderRadius: 12, gap: 12, padding: 18 },
  label: { color: "#243047", fontSize: 14, fontWeight: "600" },
  input: {
    borderColor: "#cbd3df",
    borderRadius: 8,
    borderWidth: 1,
    color: "#172033",
    padding: 12,
  },
  address: { color: "#243047", fontSize: 13, lineHeight: 20 },
  button: {
    alignItems: "center",
    backgroundColor: "#3159d9",
    borderRadius: 8,
    padding: 14,
  },
  buttonText: { color: "#fff", fontWeight: "700" },
  disabled: { opacity: 0.45 },
  error: { color: "#b42318", padding: 24 },
  warning: {
    backgroundColor: "#fff7e5",
    borderColor: "#e7c56b",
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
    padding: 18,
  },
});
