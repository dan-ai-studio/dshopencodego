/**
 * Host half of the network Remote.
 *
 * The page needs to know which address the gateway is sent to, and whether
 * that address is still working: a pin that was found to be gone leaves the
 * requests on the system's own resolution, and a page that kept showing the
 * old address would claim a speed the plugin is no longer delivering.
 *
 * @module @dan-ai-studio/dshopencodego/network/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { isPinSpent, resolveGatewayPin } from './pinning.ts'
import type { NetworkReading } from './contract.ts'

/** Host inputs for the network service. */
export interface NetworkServiceOptions {
  /** Current gateway base URL. */
  readonly baseURL: () => string
  /** The configured pins, by host name. */
  readonly pinnedAddresses: () => Readonly<Record<string, string>>
}

/** The network Remote: the gateway's name, its pin, and that pin's health. */
export class OpencodeGoNetworkService extends TypertRemoteService {
  private readonly options: NetworkServiceOptions

  constructor(ctx: Context, options: NetworkServiceOptions) {
    super(ctx, 'opencodeGoNetwork')
    this.options = options
  }

  /** The gateway's name and its pin, as the configuration states them. */
  async readNetwork(): Promise<NetworkReading> {
    const pin = resolveGatewayPin(this.options.pinnedAddresses(), this.options.baseURL())
    return {
      host: pin.host,
      ...pin.address === undefined ? {} : { address: pin.address },
      ...pin.address === undefined || !isPinSpent(pin) ? {} : { failed: true },
    }
  }
}
