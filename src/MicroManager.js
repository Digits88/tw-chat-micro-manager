import Promise from "bluebird";
import moment from "moment";
import { CronJob } from "cron";
import { APIClient, Bot } from "@teamwork/tw-chat";

const BATCH_DELAY = 10000;

const COMMANDS = {
    UPDATE_CLOCK: /^clock (in|out)$/i,
    CANCEL_CLOCK_OUT: /^(?:don'?t|no|stop) clock out$/i,
    DISPLAY_CLOCK_STATUS: /^(?:show (?:me my ))?status$/
};

const ICON_OK = ":white_check_mark:";
const ICON_ALERT = ":eight_spoked_asterisk:";
const ICON_CLOCK = ":clock1:";
const ICON_ERROR = ":x:";

Promise.config({ cancellation: true });

export default class MicroManager extends Bot {
    async start(options) {
        this.log.add(Bot.transports.File, { filename: "micro-manager.log" });
        this.log.info("creating new micro manager", options);        

        this.options = options;
        this.userAPI = new APIClient(this.chat.api.installation, this.options.user.auth);

        await this.userAPI.initialize();

        this.currentBatch = [];
        this.target = await this.chat.getPersonByHandle(this.options.user.handle);

        // Create the cron jobs
        this.crons = {
            clockIn: new CronJob("0 15 9 * * 1-5", this.autoClockIn.bind(this), this.handleCronEnd.bind(this, "clockIn"), false, "Europe/Dublin"),
            clockOut: new CronJob("0 0 18 * * 1-5", this.autoClockOut.bind(this), this.handleCronEnd.bind(this, "clockOut"), false, "Europe/Dublin"),
            promptActivity: new CronJob("0 */15 * * * *", this.promptActivity.bind(this), this.handleCronEnd.bind(this, "promptActivity"), false, "Europe/Dublin")
        };

        this.target.on("message:received", this.handleMessage.bind(this));

        // Start the crons
        Object.values(this.crons).forEach(job => job.start());

        await this.target.sendMessage(`Hi ${this.target.firstName}, I'm going to keep you on your toes. Expect me to be annoying.`);
    }

    async stop() {
        Object.values(this.crons).forEach(job => job.stop());

        await this.target.sendMessage(`Micro-managing off.`);
    }

    handleMessage(message) {
        const command = matchCommand(message.content);

        if(command) {
            return this.handleCommand(...command);
        }

        // Batch logs 
        const logs = message.content.split("\n")
            .filter(log => log.trim().startsWith(">"))
            .map(log => log.replace(/^>\s*/, ""));

        if(logs.length) {
            return this.batchLogs(logs);
        }
    }

    handleCommand(command, ...args) {
        this.log.info("received command", { command, args });

        Promise.try(async () => {
            switch(command) {
                case "UPDATE_CLOCK":
                    const direction = args[0];

                    if(direction === "in") {
                        return this.clockIn();
                    } else {
                        if(this.deferredClockout) {
                            this.deferredClockout.cancel();
                        }

                        return this.clockOut();
                    }
                break;

                case "CANCEL_CLOCK_OUT":
                    if(!this.deferredClockout) {
                        throw new Error(`Don't worry, I wasn't going to clock you out. Alls good.`);
                    }

                    this.deferredClockout.cancel();
                    this.deferClockout();

                    return this.target.sendMessage(`${ICON_CLOCK} Auto-clockout postponed for 30 minutes. To manually clock out, say "clock out".`);
                break;

                case "DISPLAY_CLOCK_STATUS":

                    return this.target.sendMessage(await this.getStatusMessage());
                break;
            }
        }).catch(error => {
            return this.target.sendMessage(`${ICON_ERROR} ${error.message}`);
        });
    }

    handleCronEnd(job) {
        this.log.info(`${job} cron job complete`, { job });
    }

    batchLogs(logs) {
        this.currentBatch = this.currentBatch.concat(logs);
        this.postponeBatchLog();
    }

    postponeBatchLog() {
        if(this.batchUpdate) {
            this.batchUpdate.cancel();
        }

        this.batchUpdate = Promise.delay(BATCH_DELAY).then(this.logBatch.bind(this));
    }

    async logBatch() {
        if(!await this.isClockedIn()) {
            // Clock the user if they're not already
            await this.clockIn();
        }

        const lastUpdate = await this.getLastUpdateToday()
        const logDuration = moment.duration(moment().diff(lastUpdate));

        if(logDuration.asMinutes() < 15) {
            // Add 15 minutes to the log
            logDuration.add(15, "m");
        }

        const logs = this.currentBatch;
        this.log.info(`Logging: \n\t* ${logs.map(log => log.content).join("\n\t* ")}`);

        await this.userAPI.request(`/projects/${this.options.project}/time_entries.json`, {
            method: "POST",
            body: {
                "time-entry": {
                    description: " * " + logs.join("\n * "),
                    time: lastUpdate.format("HH:mm"),
                    date: lastUpdate.format("YYYYMMDD"),
                    hours: logDuration.hours(),
                    minutes: logDuration.minutes(),
                    "person-id": `${this.userAPI.user.id}`,
                    tags: "micro-manager",
                    isBillable: false
                }
            }
        });

        this.batchUpdate = null;
        this.currentBatch = [];

        await this.target.sendMessage(`${ICON_OK} Cool. Added ${logs.length} log${logs.length > 1 ? "s" : ""}.`);
    }

    async clockIn() {
        if(await this.isClockedIn()) {
            this.log.info("attempting to clock in but already clocked in");
            return await this.target.sendMessage(`${ICON_CLOCK} You're already clocked in.`);
        }

        this.log.info("clocking in");
        await this.userAPI.request("/me/clockin.json", { method: "POST" });

        const HH = moment().hours();

        let greeting = "morning";
        if(HH > 12 && HH < 16) greeting = "good afternoon";
        else if(HH > 16 && HH < 20) greeting = "good evening";

        await this.target.sendMessage(`${ICON_CLOCK} Clocking you in ${this.target.firstName}, ${greeting}.`);
    }

    async clockOut() {
        if(!(await this.isClockedIn())) {
            this.log.info("attempting to clock out but already clocked out");
            return await this.target.sendMessage(`${ICON_CLOCK} You're already clocked out.`);
        }

        this.log.info("clocking out");
        await this.userAPI.request("/me/clockout.json", { method: "POST" });

        await this.target.sendMessage(`${ICON_CLOCK} Clocking you out ${this.target.firstName}, good bye.`);
    }

    async getClockIns() {
        return (await this.userAPI.request("/me/clockins.json"))["clockIns"];
    }

    async getActiveClockIn() {
        const latest = await this.getLatestClockIn();

        if(!latest.clockOutDatetime) {
            return latest;
        }
    }

    async getLatestClockIn() {
        return (await this.getClockIns())[0];
    }

    async isClockedIn() {
        return !!(await this.getActiveClockIn());
    }

    async getTimeEntries() {
        return (await this.userAPI.request(`/projects/${this.options.project}/time_entries.json`, {
            query: {
                page: 1,
                pageSize: 20,
                sortBy: "date",
                sortOrder: "desc"
            }
        }))["time-entries"].sort(dateComparator("date"));
    }

    async getTimeEntriesAfter(date) {
        return (await this.getTimeEntries()).filter(entry => {
            return getTimeEntryEnd(entry).isAfter(date);
        });
    }

    async getTimeEntriesForToday() {
        return await this.getTimeEntriesAfter(moment().startOf("day"));
    }

    async getLatestTimeEntry() {
        return (await this.getTimeEntries())[0];
    }

    async getLastUpdateToday() {
        const todaysEntries = await this.getTimeEntriesForToday();

        if(todaysEntries.length) {
            return getTimeEntryEnd(todaysEntries[0]);
        } else {
            const clockIn = this.getActiveClockIn();

            if(clockIn) {
                return moment(clockIn.clockInDatetime);
            }
        }
    }

    async promptActivity() {
        this.log.info("prompting activity");

        let lastUpdatePrompt = "";
        const lastUpdate = await this.getLastUpdateToday()
        if(lastUpdate) {
            const diff = moment.duration(moment().diff(lastUpdate));
            lastUpdatePrompt = `, it's been ${diff.humanize()} since your last update`;
        }

        await this.target.sendMessage(
            `${ICON_ALERT} Hey ${this.target.firstName}${lastUpdatePrompt}. What are you doing?`
        );
    }

    async autoClockOut() {
        await this.target.sendMessage(
            `${ICON_CLOCK} Automatically clocking you out in 15 minutes. Reply "no clock out" to postpone for 30 minutes.`
        );

        this.deferClockout();
    }

    async autoClockIn() {
        await this.clockIn();

        await this.target.sendMessage(
            `${ICON_CLOCK} Automatically clocked you in. Morning.`
        );
    }

    async getStatusMessage() {
        const clockIn = await this.getLatestClockIn();
        const inTime = moment(clockIn.clockInDatetime);
        const clockedIn = !clockIn.clockOutDatetime;

        let message;
        if(clockedIn) {
            message = `${ICON_CLOCK} You are clocked in since ${inTime.format("HH:mm")} today.`;

            const todaysEntries = await this.getTimeEntriesForToday();

            if(todaysEntries.length) {
                const lastEntry = todaysEntries[0];
                const entryDuration = moment.duration(parseInt(lastEntry.hours), "h").add(parseInt(lastEntry.minutes), "m");
                const entryStart = moment(lastEntry.date);
                const entryEnd = moment(entryStart).add(entryDuration);
                message += ` Your last time entry was ${entryDuration.humanize()} long starting at ${entryStart.format("HH:mm")} (to ${entryEnd.format("HH:mm")}).\n\n`
                message += "> " + lastEntry.description.split("\n").join("\n> ");
            } else {
                message += " You have not logged any time today.";
            }
        } else {
            message = `${ICON_CLOCK} You are clocked out. You were clocked in from ${inTime.calendar()} to ${moment(clockIn.clockOutDatetime).calendar()}.`;
        }

        return message;
    }

    deferClockout() {
        this.deferredClockout = Promise.delay(1000 * 60 * 30).then(this.clockout.bind(this));
    }
}

export function matchCommand(message) {
    return Object.keys(COMMANDS).reduce((match, command) => {
        if(match)
            return match;

        match = message.match(COMMANDS[command]);

        if(match) 
            return [command, ...match.slice(1).map(arg => arg.trim().toLowerCase())];
    }, null);
}

function dateComparator(prop) {
    return (a, b) => {
        // Sort them by most recent
        a = new Date(a[prop]);
        b = new Date(b[prop]);
        return a > b ? -1 : a < b ? 1 : 0;
    }
}

function getTimeEntryEnd(entry) {
    return moment(entry.date)
        .add(parseInt(entry.hours), "h")
        .add(parseInt(entry.minutes), "m");
}