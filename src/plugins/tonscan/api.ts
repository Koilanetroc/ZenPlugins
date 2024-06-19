import qs from 'querystring'
import { fetchJson, FetchOptions, FetchResponse } from '../../common/network'
import get from '../../types/get'
import { SUPPORTED_JETTONS } from './config'
import { delay } from '../../common/utils'

const MAX_RPS = 1

export interface Preferences {
  wallets: string
}

export interface JettonInfo {
  address: string
  ownerWithJettonType: string
  jetton: string
  jettonType: string
  owner: string
  balance: number
  decimals: number
}

export interface WalletInfo {
  address: string
  balance: number
}

export interface TonTransaction {
  transactionId: string
  fromAddress: string
  toAddress: string
  quantity: number
  timestamp: number
}

export interface RawJettonTransfer {
  transaction_hash: string
  source: string
  destination: string
  amount: number
  transaction_now: number
}

export interface JettonTransfer {
  jettonAddress: string
  transactionId: string
  fromAddress: string
  toAddress: string
  quantity: number
  timestamp: number
}

export interface Msg {
  hash: string
  source: string
  destination: string
  value: number
  created_at: number
}

export interface AddressBook {
  [key: string]: { user_friendly: string }
}

export class TonscanApi {
  private readonly baseUrl: string
  private activeList: Array<Promise<unknown>> = []

  constructor (options: { baseUrl: string}) {
    this.baseUrl = options.baseUrl
  }

  private async fetchApi (
    url: string,
    options?: FetchOptions,
    predicate?: (x: FetchResponse) => boolean
  ): Promise<FetchResponse> {
    if (this.activeList.length < MAX_RPS) {
      const request = this.fetchInner(url, options, predicate)

      const waiter = request
        .then(async () => await delay(1300))
        .catch(async () => await delay(1300))
        .then(() => {
          this.activeList = this.activeList.filter(item => item !== waiter)
        })

      this.activeList.push(waiter)

      const result = await request

      return result
    }

    await Promise.race(this.activeList)
    return await this.fetchApi(url, options, predicate)
  }

  private async fetchInner (
    url: string,
    options?: FetchOptions,
    predicate?: (x: FetchResponse) => boolean
  ): Promise<FetchResponse> {
    const response = await fetchJson(this.baseUrl + url, options)

    if (predicate) {
      this.validateResponse(
        response,
        response => !get(response.body, 'error') && predicate(response)
      )
    }

    return response
  }

  private validateResponse (
    response: FetchResponse,
    predicate?: (x: FetchResponse) => boolean
  ): void {
    console.assert(!predicate || predicate(response), 'non-successful response')
  }

  public async fetchJettons (ownerWalletAddress: string): Promise<JettonInfo[]> {
    const response = await this.fetchApi(
      `v3/jetton/wallets?${qs.stringify({
        owner_address: ownerWalletAddress
      })}`,
      undefined,
      (res) => typeof res.body === 'object' && res.body != null && 'jetton_wallets' in res.body
    ) as FetchResponse & { body: { jetton_wallets: Array<Record<string, unknown>> } }

    return response.body.jetton_wallets
      .filter(t => Object.keys(SUPPORTED_JETTONS).includes(t.jetton as string))
      .map(t => ({
        address: t.address as string,
        jetton: t.jetton as string,
        jettonType: SUPPORTED_JETTONS[t.jetton as string].ticker,
        decimals: SUPPORTED_JETTONS[t.jetton as string].decimals,
        owner: ownerWalletAddress,
        ownerWithJettonType: `${ownerWalletAddress}_${SUPPORTED_JETTONS[t.jetton as string].ticker}`,
        balance: t.balance as number
      }))
  }

  public async fetchWallet (wallet: string): Promise<WalletInfo> {
    const response = await this.fetchApi(
      `v3/wallet?${qs.stringify({
      address: wallet
      })}`,
      undefined,
      (res) => typeof res.body === 'object' && res.body != null && 'balance' in res.body
    ) as FetchResponse & { body: { balance: string } }

    return {
      address: wallet,
      balance: parseFloat(response.body.balance)
    }
  }

  public async fetchAddressBook (addresses: string[]): Promise<AddressBook> {
    const response = await this.fetchApi(
      `v3/addressBook?${qs.stringify({
      address: addresses
      })}`,
      undefined,
      (res) => typeof res.body === 'object' && res.body != null
    ) as FetchResponse & { body: AddressBook }

    return response.body
  }

  public async fetchTonTransactions (ownerWalletAddress: string, fromDate: Date, toDate?: Date): Promise<TonTransaction[]> {
    const transactions: TonTransaction[] = []
    let offset = 0
    const limit = 30

    while (true) {
      const response = await this.fetchApi(
        `v3/transactions?${qs.stringify({
          account: ownerWalletAddress,
          start_utime: Math.floor((fromDate).getTime() / 1000),
          end_utime: Math.floor((toDate ?? new Date()).getTime() / 1000),
          limit,
          offset,
          sort: 'desc'
        })}`) as FetchResponse & { body: { transactions: Array<{ in_msg: Msg, out_msgs: Msg[] }>, address_book: AddressBook } }

      const incomeTransactions = response.body.transactions.filter(t => t.in_msg?.value > 1)
      const outcomeTransactions = response.body.transactions.flatMap(t => t.out_msgs).filter(msg => msg.value > 1)
      const addressBook = response.body.address_book

      transactions.push(...incomeTransactions.map(t => ({
        transactionId: t.in_msg.hash,
        fromAddress: addressBook[t.in_msg.source].user_friendly,
        toAddress: addressBook[t.in_msg.destination].user_friendly,
        quantity: t.in_msg.value,
        timestamp: t.in_msg.created_at
      })))

      transactions.push(...outcomeTransactions.map(t => ({
        transactionId: t.hash,
        fromAddress: addressBook[t.source].user_friendly,
        toAddress: addressBook[t.destination].user_friendly,
        quantity: t.value,
        timestamp: t.created_at
      })))

      if (limit > response.body.transactions.length) {
        break
      }

      offset += limit
    }

    return transactions
  }

  public async fetchJettonsTransfers (jettons: JettonInfo[], fromDate: Date, toDate?: Date): Promise<JettonTransfer[]> {
    const transfers: JettonTransfer[] = []

    // fetch each supported jetton transfers separately to avoid fetching all trasnfers of unsupported jettons
    for (const jetton of jettons) {
      let offset = 0
      const limit = 50

      while (true) {
        const response = await this.fetchApi(
          `v3/jetton/transfers?${qs.stringify({
            address: jetton.owner,
            jetton_master: jetton.jetton,
            start_utime: Math.floor((fromDate).getTime() / 1000),
            end_utime: Math.floor((toDate ?? new Date()).getTime() / 1000),
            limit,
            offset,
            sort: 'desc'
          })}`) as FetchResponse & { body: { jetton_transfers: RawJettonTransfer[] } }

        transfers.push(...response.body.jetton_transfers.map(t => ({
          jettonAddress: jetton.address,
          transactionId: t.transaction_hash,
          fromAddress: t.source,
          toAddress: t.destination,
          quantity: t.amount,
          timestamp: t.transaction_now
        })))

        if (limit > response.body.jetton_transfers.length) {
          break
        }

        offset += limit
      }
    }

    if (transfers.length === 0) {
      return []
    }

    const uniqueAddresses = [...new Set([...transfers.map(t => t.fromAddress), ...transfers.map(t => t.toAddress)])]
    const addressBook = await this.fetchAddressBook(uniqueAddresses)

    // replace raw addresses with user_friendly forms
    const updatedTransfers = transfers.map(t => ({
      ...t,
      fromAddress: addressBook[t.fromAddress]?.user_friendly !== undefined ? addressBook[t.fromAddress]?.user_friendly : t.fromAddress,
      toAddress: addressBook[t.toAddress]?.user_friendly !== undefined ? addressBook[t.toAddress]?.user_friendly : t.toAddress
    }))

    return updatedTransfers
  }
}

export const tonscanApi = new TonscanApi({
  baseUrl: 'https://toncenter.com/api/'
})
