export const authHeaderMiddleware = (req: any, res: any, next: any) => {
    const required_auth_header = "x-api-key";

    if (!req.headers[required_auth_header.toLowerCase()]) {
        console.log("Missing auth header");
        return res.status(401).json({ status: 'ERROR', code: 'UNAUTHORIZED', message: 'Missing x-api-key header' });
    }

    if (req.headers[required_auth_header.toLowerCase()] !== process.env.X_API_KEY) {
        console.log("Invalid auth header");
        return res.status(401).json({ status: 'ERROR', code: 'UNAUTHORIZED', message: 'Invalid x-api-key' });
    }

    next();
};
