import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';

import { LumenWalletCard } from '../src/components/LumenWalletCard';
import { LumenBalance } from '../src/components/LumenBalance';
import { LumenConnectModal } from '../src/components/LumenConnectModal';
import { LumenTransactionFeed } from '../src/components/LumenTransactionFeed';
import { LumenSwapWidget } from '../src/components/LumenSwapWidget';

const noop = () => undefined;

const walletCardMeta: Meta<typeof LumenWalletCard> = {
  title: 'Lumen/LumenWalletCard',
  component: LumenWalletCard,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    address: { control: 'text' },
    balance: { control: 'text' },
    network: {
      control: 'select',
      options: ['mainnet', 'testnet', 'futurenet', 'custom'],
    },
    variant: {
      control: 'select',
      options: ['default', 'gradient', 'outline'],
    },
    showCopyButton: { control: 'boolean' },
    onCopy: { action: 'copied' },
  },
};

export default walletCardMeta;

type WalletCardStory = StoryObj<typeof LumenWalletCard>;

export const WalletCardDefault: WalletCardStory = {
  name: 'Default',
  args: {
    address: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
    balance: '1,250.00 XLM',
    network: 'testnet',
    variant: 'default',
    showCopyButton: true,
    onCopy: noop,
  },
};

export const WalletCardGradient: WalletCardStory = {
  name: 'Gradient',
  args: {
    ...WalletCardDefault.args,
    variant: 'gradient',
  },
};

export const WalletCardOutline: WalletCardStory = {
  name: 'Outline',
  args: {
    ...WalletCardDefault.args,
    variant: 'outline',
  },
};

const balanceMeta: Meta<typeof LumenBalance> = {
  title: 'Lumen/LumenBalance',
  component: LumenBalance,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    amount: { control: 'text' },
    symbol: { control: 'text' },
    decimals: { control: { type: 'number', min: 0, max: 8 } },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
    showSymbol: { control: 'boolean' },
    loading: { control: 'boolean' },
  },
};

export const BalanceDefault: StoryObj<typeof LumenBalance> = {
  name: 'Default',
  args: {
    amount: '1250.5',
    symbol: 'XLM',
    decimals: 2,
    size: 'md',
    showSymbol: true,
    loading: false,
  },
};

export const BalanceLoading: StoryObj<typeof LumenBalance> = {
  name: 'Loading',
  args: {
    ...BalanceDefault.args,
    loading: true,
  },
};

export const BalanceLarge: StoryObj<typeof LumenBalance> = {
  name: 'Large',
  args: {
    ...BalanceDefault.args,
    size: 'lg',
    amount: '987654.321',
  },
};

const connectModalMeta: Meta<typeof LumenConnectModal> = {
  title: 'Lumen/LumenConnectModal',
  component: LumenConnectModal,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    open: { control: 'boolean' },
    title: { control: 'text' },
    description: { control: 'text' },
    wallets: { control: 'object' },
    onClose: { action: 'closed' },
    onConnect: { action: 'connected' },
  },
};

export const ConnectModalOpen: StoryObj<typeof LumenConnectModal> = {
  name: 'Open',
  args: {
    open: true,
    title: 'Connect a Wallet',
    description: 'Choose a wallet to connect to Lumen.',
    wallets: [
      { id: 'freighter', name: 'Freighter', icon: undefined },
      { id: 'xbull', name: 'xBull', icon: undefined },
      { id: 'albedo', name: 'Albedo', icon: undefined },
    ],
    onClose: noop,
    onConnect: noop,
  },
};

export const ConnectModalClosed: StoryObj<typeof LumenConnectModal> = {
  name: 'Closed',
  args: {
    ...ConnectModalOpen.args,
    open: false,
  },
};

const transactionFeedMeta: Meta<typeof LumenTransactionFeed> = {
  title: 'Lumen/LumenTransactionFeed',
  component: LumenTransactionFeed,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    transactions: { control: 'object' },
    loading: { control: 'boolean' },
    emptyMessage: { control: 'text' },
    maxItems: { control: { type: 'number', min: 1, max: 50 } },
    onTransactionClick: { action: 'transactionClicked' },
  },
};

const sampleTransactions = [
  {
    id: 'tx-1',
    hash: 'a1b2c3d4e5f6',
    type: 'payment' as const,
    amount: '100.00',
    asset: 'XLM',
    status: 'success' as const,
    timestamp: '2024-01-15T10:30:00Z',
    from: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
    to: 'GZYXWVUTSRQPONMLKJIHGFEDCBA765432ZYXWVUTSRQPONMLKJIHGFED',
  },
  {
    id: 'tx-2',
    hash: 'f6e5d4c3b2a1',
    type: 'swap' as const,
    amount: '50.00',
    asset: 'USDC',
    status: 'pending' as const,
    timestamp: '2024-01-15T09:12:00Z',
    from: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
    to: 'GZYXWVUTSRQPONMLKJIHGFEDCBA765432ZYXWVUTSRQPONMLKJIHGFED',
  },
  {
    id: 'tx-3',
    hash: '1234567890ab',
    type: 'payment' as const,
    amount: '25.00',
    asset: 'XLM',
    status: 'failed' as const,
    timestamp: '2024-01-14T18:45:00Z',
    from: 'GZYXWVUTSRQPONMLKJIHGFEDCBA765432ZYXWVUTSRQPONMLKJIHGFED',
    to: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
  },
];

export const TransactionFeedDefault: StoryObj<typeof LumenTransactionFeed> = {
  name: 'Default',
  args: {
    transactions: sampleTransactions,
    loading: false,
    emptyMessage: 'No transactions yet.',
    maxItems: 10,
    onTransactionClick: noop,
  },
};

export const TransactionFeedLoading: StoryObj<typeof LumenTransactionFeed> = {
  name: 'Loading',
  args: {
    ...TransactionFeedDefault.args,
    transactions: [],
    loading: true,
  },
};

export const TransactionFeedEmpty: StoryObj<typeof LumenTransactionFeed> = {
  name: 'Empty',
  args: {
    ...TransactionFeedDefault.args,
    transactions: [],
    loading: false,
  },
};

const swapWidgetMeta: Meta<typeof LumenSwapWidget> = {
  title: 'Lumen/LumenSwapWidget',
  component: LumenSwapWidget,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    fromAsset: { control: 'text' },
    toAsset: { control: 'text' },
    fromAmount: { control: 'text' },
    toAmount: { control: 'text' },
    slippage: { control: { type: 'number', min: 0, max: 100, step: 0.1 } },
    loading: { control: 'boolean' },
    disabled: { control: 'boolean' },
    onSwap: { action: 'swapped' },
    onFromAmountChange: { action: 'fromAmountChanged' },
    onToAmountChange: { action: 'toAmountChanged' },
  },
};

export const SwapWidgetDefault: StoryObj<typeof LumenSwapWidget> = {
  name: 'Default',
  args: {
    fromAsset: 'XLM',
    toAsset: 'USDC',
    fromAmount: '100',
    toAmount: '12.5',
    slippage: 0.5,
    loading: false,
    disabled: false,
    onSwap: noop,
    onFromAmountChange: noop,
    onToAmountChange: noop,
  },
};

export const SwapWidgetLoading: StoryObj<typeof LumenSwapWidget> = {
  name: 'Loading',
  args: {
    ...SwapWidgetDefault.args,
    loading: true,
  },
};

export const SwapWidgetDisabled: StoryObj<typeof LumenSwapWidget> = {
  name: 'Disabled',
  args: {
    ...SwapWidgetDefault.args,
    disabled: true,
  },
};