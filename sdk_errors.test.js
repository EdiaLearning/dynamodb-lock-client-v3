"use strict";

const {FailOpen, FailClosed} = require("./index.js");

function acquire(client)
{
    return new Promise((resolve, reject) => client.acquireLock("contact:test", (error, lock) =>
        error ? reject(error) : resolve(lock)));
}

function release(lock)
{
    return new Promise((resolve, reject) => lock.release(error =>
        error ? reject(error) : resolve()));
}

// Legacy index.test.js mocks use callbacks; these exercise the promise-based SDK interface.
describe.each(["name", "code"])("Conditional errors identified by %s", field =>
{
    function conditionalError()
    {
        return Object.assign(new Error("The conditional request failed"), {
            [field]: "ConditionalCheckFailedException"
        });
    }

    function clientFor(mode, putItem, deleteItem = async () => ({}))
    {
        const config = {
            lockTable: "test",
            partitionKey: "id",
            retryCount: 1,
            dynamodb: {
                getItem: async () => mode === "existing" ? {
                    Item: {
                        guid: {S: "previous-owner"},
                        fencingToken: {N: "1"},
                        leaseDurationMs: {N: "1"}
                    }
                } : {},
                putItem,
                deleteItem
            }
        };
        return mode === "closed" ? new FailClosed({...config, acquirePeriodMs: 1}) :
            new FailOpen({...config, leaseDurationMs: 10});
    }

    test.each(["new", "existing", "closed"])("retries %s lock contention", async mode =>
    {
        const putItem = jest.fn().mockRejectedValueOnce(conditionalError()).mockResolvedValue({});
        const lock = await acquire(clientFor(mode, putItem));
        expect(putItem).toHaveBeenCalledTimes(2);
        await release(lock);
    });

    test("exhausts the retry budget", async () =>
    {
        const error = conditionalError();
        const putItem = jest.fn().mockRejectedValue(error);
        await expect(acquire(clientFor("new", putItem))).rejects.toMatchObject({
            code: "FailedToAcquireLock", originalError: error
        });
        expect(putItem).toHaveBeenCalledTimes(2);
    });

    test("does not retry unrelated errors", async () =>
    {
        const error = new Error("Database unavailable");
        const putItem = jest.fn().mockRejectedValue(error);
        await expect(acquire(clientFor("new", putItem))).rejects.toBe(error);
        expect(putItem).toHaveBeenCalledTimes(1);
    });

    test("tolerates fail-open release after another owner claims the lock", async () =>
    {
        const putItem = jest.fn().mockResolvedValueOnce({}).mockRejectedValue(conditionalError());
        const lock = await acquire(clientFor("new", putItem));
        await expect(release(lock)).resolves.toBeUndefined();
    });

    test("reports fail-closed release ownership failures", async () =>
    {
        const error = conditionalError();
        const lock = await acquire(clientFor("closed", async () => ({}), async () => {throw error;}));
        await expect(release(lock)).rejects.toMatchObject({
            code: "FailedToReleaseLock", originalError: error
        });
    });
});
