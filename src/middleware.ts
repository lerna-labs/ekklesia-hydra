export const authHeaderMiddleware = (req: any, res: any, next: any) => {
    const required_auth_header = "x-api-key";

    if (!req.headers[required_auth_header.toLowerCase()]) {
        console.log("Missing header");
        return res.status(404).send();
    }

    if (req.headers[required_auth_header.toLowerCase()] !== process.env.X_API_KEY) {
        console.log("Header doesn't match expected", req.headers[required_auth_header.toLowerCase()], process.env.X_API_KEY);
        return res.status(404).send();
    }

    next();
};