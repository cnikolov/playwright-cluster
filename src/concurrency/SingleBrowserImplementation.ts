
import * as playwright from 'playwright';
import ConcurrencyImplementation, { ResourceData } from './ConcurrencyImplementation';

import { debugGenerator, timeoutExecute } from '../util';
const debug = debugGenerator('SingleBrowserImpl');

const BROWSER_TIMEOUT = 5000;

export default abstract class SingleBrowserImplementation extends ConcurrencyImplementation {

    protected browser: playwright.Browser | null = null;

    private repairing: boolean = false;
    private repairRequested: boolean = false;
    private openInstances: number = 0;
    private waitingForRepairResolvers: (() => void)[] = [];

    public constructor(options: playwright.LaunchOptions, playwright: playwright.BrowserType<{}>, pageOptions: playwright.BrowserContextOptions | undefined) {
        super(options, playwright, pageOptions);
    }

    private async repair() {
        if (this.openInstances !== 0 || this.repairing) {
            // already repairing or there are still pages open? wait for start/finish
            await new Promise<void>(resolve => this.waitingForRepairResolvers.push(resolve));
            return;
        }

        this.repairing = true;
        debug('Starting repair');

        try {
            // will probably fail, but just in case the repair was not necessary
            await (<playwright.Browser>this.browser).close();
        } catch (e) {
            debug('Unable to close browser.');
        }

        try {
            this.browser = await this.playwright.launch(this.options) as playwright.Browser;
        } catch (err) {
            throw new Error('Unable to restart chrome.');
        }
        this.repairRequested = false;
        this.repairing = false;
        this.waitingForRepairResolvers.forEach(resolve => resolve());
        this.waitingForRepairResolvers = [];
    }

    public async init() {
        this.browser = await this.playwright.launch(this.options);
    }

    public async close() {
        await (this.browser as playwright.Browser).close();
    }

    protected abstract createResources(): Promise<ResourceData>;

    protected abstract freeResources(resources: ResourceData): Promise<void>;

    public async workerInstance() {
        let resources: ResourceData;

        return {
            jobInstance: async () => {
                if (this.repairRequested) {
                    await this.repair();
                }
                await timeoutExecute(BROWSER_TIMEOUT, (async () => {
                    resources = await this.createResources();
                })());
                this.openInstances += 1;

                return {
                    resources,

                    close: async () => {
                        this.openInstances -= 1; // decrement first in case of error
                        await timeoutExecute(BROWSER_TIMEOUT, this.freeResources(resources));

                        if (this.repairRequested) {
                            await this.repair();
                        }
                    },
                };
            },

            close: async () => {
                await this.close();
            },

            repair: async () => {
                debug('Repair requested');
                this.repairRequested = true;
                await this.repair();
            },
        };
    }
}
